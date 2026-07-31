import { describe, expect, it, vi } from "vitest";
import { TOKEN_VALIDITY_MS } from "@open-inspect/shared";

import { ServiceAuthNonceStore } from "./service-auth-nonces";
import type { SqlDatabase } from "./sql-database";

describe("ServiceAuthNonceStore", () => {
  it("retains future-dated nonces through the signature validity window", async () => {
    const binds: unknown[][] = [];
    const statement = {
      bind: vi.fn((...values: unknown[]) => {
        binds.push(values);
        return statement;
      }),
    };
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => [{ meta: { changes: 0 } }, { meta: { changes: 1 } }]),
    } as unknown as SqlDatabase;
    const now = 1_000_000;
    const signatureTimestampMs = now + TOKEN_VALIDITY_MS;

    await new ServiceAuthNonceStore(db).claim("modal", "nonce", signatureTimestampMs, now);

    expect(binds).toContainEqual(["modal", "nonce", signatureTimestampMs + TOKEN_VALIDITY_MS]);
  });
});
