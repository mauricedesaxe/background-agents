import { timingSafeEqual } from "../../auth";

export const BETTERSTACK_SECRET_HEADER = "x-betterstack-secret";

/** BetterStack does not sign webhooks, so authenticate a shared header secret in constant time. */
export function verifyBetterstackSecret(
  presented: string | null | undefined,
  secret: string
): boolean {
  if (!presented) return false;
  return timingSafeEqual(presented, secret);
}
