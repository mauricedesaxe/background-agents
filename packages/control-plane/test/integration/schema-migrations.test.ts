import { describe, it, expect, beforeEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import {
  applyMigrations,
  FORK_MIGRATION_ID_FLOOR,
  MIGRATIONS,
  RETIRED_LOW_IDS,
} from "../../src/session/schema";
import type { SqlStorage } from "../../src/session/repository";
import { cleanD1Tables } from "./cleanup";
import { initSession } from "./helpers";

/** The highest identifier in use that predates the reserved range. */
const LAST_SHARED_ID = 34;

interface StoreShape {
  readonly migrationIds: number[];
  readonly sandboxColumns: string[];
}

function readShape(sql: SqlStorage): StoreShape {
  const migrationRows = sql
    .exec("SELECT id FROM _schema_migrations ORDER BY id")
    .toArray() as Array<{ id: number }>;
  const columnRows = sql.exec("PRAGMA table_info(sandbox)").toArray() as Array<{ name: string }>;

  return {
    migrationIds: migrationRows.map((row) => row.id),
    sandboxColumns: columnRows.map((row) => row.name).sort(),
  };
}

async function freshShape(): Promise<StoreShape> {
  const { stub } = await initSession();
  return runInDurableObject(stub, (instance: SessionDO) => readShape(instance.ctx.storage.sql));
}

function preMoveMigrationIds(): number[] {
  return [...Array.from({ length: LAST_SHARED_ID }, (_, index) => index + 1), ...RETIRED_LOW_IDS];
}

function seedMigrationIds(sql: SqlStorage, ids: readonly number[]): void {
  sql.exec("DELETE FROM _schema_migrations");
  for (const id of ids) {
    sql.exec("INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?)", id, Date.now());
  }
}

/**
 * The old runner swallowed the duplicate-column error and recorded the row
 * anyway, so a rollback leaves rows indistinguishable from upstream's.
 */
function replayRolledBackRunner(sql: SqlStorage): void {
  const legacy = [
    [35, "ALTER TABLE sandbox ADD COLUMN stop_unreconciled_at INTEGER"],
    [36, "ALTER TABLE sandbox ADD COLUMN stop_unreconciled_provider_id TEXT"],
  ] as const;

  for (const [id, statement] of legacy) {
    try {
      sql.exec(statement);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes("duplicate column") && !message.includes("already exists")) throw e;
    }
    sql.exec(
      "INSERT OR IGNORE INTO _schema_migrations (id, applied_at) VALUES (?, ?)",
      id,
      Date.now()
    );
  }
}

describe("fork-local schema migrations", () => {
  beforeEach(cleanD1Tables);

  // Claiming a retired identifier disarms releaseRetiredIdentifiers() for it,
  // so this failing means a store may still carry a stale row at that id.
  it("leaves the retired identifiers unclaimed, and keeps its own above the floor", () => {
    const forkLocal = MIGRATIONS.filter((migration) => migration.id >= FORK_MIGRATION_ID_FLOOR);
    expect(forkLocal.length).toBeGreaterThan(0);

    const lowIds = MIGRATIONS.filter((migration) => migration.id < FORK_MIGRATION_ID_FLOOR).map(
      (migration) => migration.id
    );
    for (const id of RETIRED_LOW_IDS) {
      expect(lowIds).not.toContain(id);
    }
  });

  it("frees the retired identifiers on a store that already ran them", async () => {
    const expected = await freshShape();
    const { stub } = await initSession();

    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      seedMigrationIds(sql, preMoveMigrationIds());

      applyMigrations(sql);

      expect(readShape(sql)).toEqual(expected);
    });
  });

  it("frees the retired identifiers again after a rollback recreated their rows", async () => {
    const expected = await freshShape();
    const { stub } = await initSession();

    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      seedMigrationIds(sql, preMoveMigrationIds());

      applyMigrations(sql);
      replayRolledBackRunner(sql);
      applyMigrations(sql);

      expect(readShape(sql)).toEqual(expected);
    });
  });

  it("adds the stop-unreconciled columns to a store that never ran them", async () => {
    const expected = await freshShape();
    const { stub } = await initSession();

    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      // Reproduce a store that predates the columns entirely.
      sql.exec("ALTER TABLE sandbox DROP COLUMN stop_unreconciled_at");
      sql.exec("ALTER TABLE sandbox DROP COLUMN stop_unreconciled_provider_id");
      sql.exec(`DELETE FROM _schema_migrations WHERE id > ${LAST_SHARED_ID}`);

      applyMigrations(sql);

      expect(readShape(sql)).toEqual(expected);
    });
  });

  it("no-ops when re-run against an already-migrated store", async () => {
    const { stub } = await initSession();

    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      const before = readShape(sql);

      applyMigrations(sql);

      expect(readShape(sql)).toEqual(before);
    });
  });
});
