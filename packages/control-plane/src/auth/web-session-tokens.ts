/**
 * Web session tokens (`oi_at_`) and their rotating refresh tokens (`oi_rt_`).
 *
 * Minted only by the provider-verified exchange; opaque,
 * hash-at-rest, individually revocable. Renewal is a refresh grant with
 * rotation — redeeming a refresh token mints a new pair and consumes the old
 * one, and reuse of a consumed token revokes its whole family.
 *
 * Reuse within REFRESH_REUSE_GRACE_MS of the original rotation is treated as
 * a benign concurrent renewal (NextAuth's jwt callback runs in contexts that
 * cannot all persist the rotated cookie), rejected without family revocation.
 * Reuse after the grace window is the attack signal and revokes the family.
 */

import { REFRESH_REUSE_GRACE_MS } from "@open-inspect/shared";

import { generateId, hashToken } from "./crypto";
import { decryptToken, encryptToken } from "./crypto";
import { base64UrlEncode } from "./encoding";
import type { WebAuthProvider } from "./subject-verification";
import type { ApiTokenRow, WebSessionTokenStore } from "../db/api-tokens";
import { z } from "zod";

export { REFRESH_REUSE_GRACE_MS };

export const WEB_SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
export const WEB_SESSION_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const WEB_SESSION_FAMILY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_PREFIX = "oi_at_";
export const REFRESH_TOKEN_PREFIX = "oi_rt_";

/** The provider-verified subject a token pair was minted for. */
export interface TokenSubject {
  provider: WebAuthProvider;
  providerUserId: string;
}

export interface WebSessionTokenPair {
  accessToken: string;
  accessTokenExpiresAtEpochMs: number;
  refreshToken: string;
  refreshTokenExpiresAtEpochMs: number;
}

const webSessionTokenPairSchema = z.strictObject({
  accessToken: z.string().min(1),
  accessTokenExpiresAtEpochMs: z.number().int().positive(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAtEpochMs: z.number().int().positive(),
});

export type AccessTokenVerification =
  | {
      ok: true;
      tokenId: string;
      userId: string;
      provider: WebAuthProvider;
      providerUserId: string;
    }
  | { ok: false; failure: "unknown" | "expired" | "revoked" };

export type RefreshRedemption =
  | { ok: true; pair: WebSessionTokenPair; userId: string; familyId: string }
  | {
      ok: false;
      /**
       * `refresh_superseded`: a benign concurrent renewal already rotated
       * this token (grace-window replay or a lost consume race) — the
       * winner's pair is live and the caller must NOT treat the grant as
       * dead. `invalid_refresh_token`: the grant is genuinely dead (unknown,
       * revoked, expired, or family-expired). `refresh_reuse_detected`:
       * replay outside the grace window — the theft signal; the family has
       * been revoked. The distinction is made HERE, where the row state is
       * known — callers must never infer it from access-token freshness.
       */
      failure: "invalid_refresh_token" | "refresh_superseded" | "refresh_reuse_detected";
      /** The rotation family when the presented token resolved to a row. */
      familyId: string | null;
    };

/** 32 random bytes as unpadded base64url — the opaque token body. */
function randomTokenBody(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * An api_tokens row as this service mints it: subject and family columns are
 * always populated (they are nullable in the schema only for future P2 token
 * kinds).
 */
interface WebSessionRow extends ApiTokenRow {
  provider: WebAuthProvider;
  providerUserId: string;
  familyId: string;
}

/**
 * Narrow a raw row to the shape this service mints — fail closed: a row
 * missing the verified subject or its rotation family was not minted by this
 * service in this shape, so the presented token is not a valid web session
 * token.
 */
function isWebSessionRow(row: ApiTokenRow): row is WebSessionRow {
  return (
    (row.provider === "github" || row.provider === "google") &&
    row.providerUserId !== null &&
    row.familyId !== null
  );
}

export class WebSessionTokenService {
  constructor(
    private readonly store: WebSessionTokenStore,
    private readonly encryptionKey?: string
  ) {}

  /** Mint a fresh pair in a new rotation family (exchange path). */
  async mintPair(userId: string, subject: TokenSubject): Promise<WebSessionTokenPair> {
    const familyId = generateId();
    const familyExpiresAt = Date.now() + WEB_SESSION_FAMILY_TTL_MS;
    const minted = await this.mintPairInFamily(userId, subject, familyId, familyExpiresAt);
    return minted.pair;
  }

  private async mintPairInFamily(
    userId: string,
    subject: TokenSubject,
    familyId: string,
    familyExpiresAt: number
  ): Promise<{ pair: WebSessionTokenPair; accessTokenId: string; refreshTokenId: string }> {
    const now = Date.now();
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomTokenBody()}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomTokenBody()}`;
    // Both leaves are clamped to the family cap: the family's absolute lifetime
    // is the ceiling for everything it mints, so a rotation near the deadline
    // must not hand out an access token that outlives the family it belongs to.
    const accessTokenExpiresAtEpochMs = Math.min(now + WEB_SESSION_TOKEN_TTL_MS, familyExpiresAt);
    const refreshTokenExpiresAtEpochMs = Math.min(
      now + WEB_SESSION_REFRESH_TTL_MS,
      familyExpiresAt
    );

    const [accessHash, refreshHash] = await Promise.all([
      hashToken(accessToken),
      hashToken(refreshToken),
    ]);
    const [accessTokenId, refreshTokenId] = await this.store.createPair([
      {
        tokenHash: accessHash,
        kind: "web_session",
        userId,
        provider: subject.provider,
        providerUserId: subject.providerUserId,
        familyId,
        expiresAt: accessTokenExpiresAtEpochMs,
        familyExpiresAt: null,
      },
      {
        tokenHash: refreshHash,
        kind: "web_session_refresh",
        userId,
        provider: subject.provider,
        providerUserId: subject.providerUserId,
        familyId,
        expiresAt: refreshTokenExpiresAtEpochMs,
        familyExpiresAt,
      },
    ]);

    return {
      pair: {
        accessToken,
        accessTokenExpiresAtEpochMs,
        refreshToken,
        refreshTokenExpiresAtEpochMs,
      },
      accessTokenId,
      refreshTokenId,
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenVerification> {
    const row = await this.store.getByHash(await hashToken(token));
    if (!row || row.kind !== "web_session") {
      return { ok: false, failure: "unknown" };
    }
    if (!isWebSessionRow(row)) {
      return { ok: false, failure: "unknown" };
    }
    if (row.revokedAt !== null) {
      return { ok: false, failure: "revoked" };
    }
    if (row.expiresAt <= Date.now()) {
      return { ok: false, failure: "expired" };
    }
    return {
      ok: true,
      tokenId: row.id,
      userId: row.userId,
      provider: row.provider,
      providerUserId: row.providerUserId,
    };
  }

  /**
   * Redeem a refresh token for a new pair, consuming it. Concurrent redemption
   * recovers the winning pair during the grace window; later reuse revokes the family.
   */
  async redeemRefreshToken(token: string): Promise<RefreshRedemption> {
    const row = await this.store.getByHash(await hashToken(token));
    if (!row || row.kind !== "web_session_refresh") {
      return { ok: false, failure: "invalid_refresh_token", familyId: null };
    }
    if (!isWebSessionRow(row)) {
      return { ok: false, failure: "invalid_refresh_token", familyId: null };
    }
    // Ordering is load-bearing: the replay (rotatedTo) check runs BEFORE the
    // revoked/expired checks so that reuse of a consumed-and-since-expired
    // token still counts as the attack signal and revokes the family.
    if (row.rotatedTo !== null) {
      const successor = await this.store.getById(row.rotatedTo);
      if (successor !== null && Date.now() - successor.createdAt <= REFRESH_REUSE_GRACE_MS) {
        const winner = await this.recoverRefreshWinner(row);
        if (winner) {
          return { ok: true, pair: winner, userId: row.userId, familyId: row.familyId };
        }
        return { ok: false, failure: "refresh_superseded", familyId: row.familyId };
      }
      await this.store.revokeFamily(row.familyId);
      return { ok: false, failure: "refresh_reuse_detected", familyId: row.familyId };
    }
    const now = Date.now();
    // A null familyExpiresAt is rejected fail-closed: this service always
    // stamps the family cap on refresh rows it mints, so a row without one
    // was not minted here and must not seed a fresh rotation family.
    if (
      row.revokedAt !== null ||
      row.expiresAt <= now ||
      row.familyExpiresAt === null ||
      row.familyExpiresAt <= now
    ) {
      return { ok: false, failure: "invalid_refresh_token", familyId: row.familyId };
    }

    const minted = await this.mintPairInFamily(
      row.userId,
      { provider: row.provider, providerUserId: row.providerUserId },
      row.familyId,
      row.familyExpiresAt
    );

    if (!this.encryptionKey) {
      await Promise.all([
        this.store.revokeToken(minted.accessTokenId),
        this.store.revokeToken(minted.refreshTokenId),
      ]);
      return { ok: false, failure: "invalid_refresh_token", familyId: row.familyId };
    }
    const refreshWinnerEncrypted = await encryptToken(
      JSON.stringify(minted.pair),
      this.encryptionKey
    );

    const consumed = await this.store.consumeRefreshToken(
      row.id,
      minted.refreshTokenId,
      refreshWinnerEncrypted
    );
    if (!consumed) {
      // Lost a concurrent redeem race — by definition within the grace
      // window. Revoke only the orphaned pair this call minted; the race
      // winner's pair stays live.
      await Promise.all([
        this.store.revokeToken(minted.accessTokenId),
        this.store.revokeToken(minted.refreshTokenId),
      ]);
      const consumedRow = await this.store.getById(row.id);
      const winner = consumedRow ? await this.recoverRefreshWinner(consumedRow) : null;
      return winner
        ? { ok: true, pair: winner, userId: row.userId, familyId: row.familyId }
        : { ok: false, failure: "refresh_superseded", familyId: row.familyId };
    }

    return { ok: true, pair: minted.pair, userId: row.userId, familyId: row.familyId };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const row = await this.store.getByHash(await hashToken(token));
    if (!row || row.kind !== "web_session_refresh" || !isWebSessionRow(row)) return;
    await this.store.revokeFamily(row.familyId);
  }

  private async recoverRefreshWinner(row: ApiTokenRow): Promise<WebSessionTokenPair | null> {
    if (!row.refreshWinnerEncrypted || !this.encryptionKey) return null;
    try {
      const decrypted = await decryptToken(row.refreshWinnerEncrypted, this.encryptionKey);
      const parsed = webSessionTokenPairSchema.safeParse(JSON.parse(decrypted));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
