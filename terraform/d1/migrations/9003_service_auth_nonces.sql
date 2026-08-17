-- Fork-local: atomically claim signed service-request nonces across isolates.
CREATE TABLE service_auth_nonces (
  service    TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (service, nonce)
);

CREATE INDEX idx_service_auth_nonces_expires_at ON service_auth_nonces(expires_at);
