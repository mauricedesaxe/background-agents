import { TOKEN_VALIDITY_MS, type ServiceName } from "@open-inspect/shared";

import type { SqlDatabase } from "./sql-database";

export class ServiceAuthNonceStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(service: ServiceName, nonce: string, now = Date.now()): Promise<boolean> {
    const [, claim] = await this.db.batch([
      this.db.prepare("DELETE FROM service_auth_nonces WHERE expires_at <= ?").bind(now),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO service_auth_nonces (service, nonce, expires_at) VALUES (?, ?, ?)"
        )
        .bind(service, nonce, now + TOKEN_VALIDITY_MS),
    ]);
    return claim.meta.changes > 0;
  }
}
