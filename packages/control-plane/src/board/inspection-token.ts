import { z } from "zod";

const inspectionTokenPayloadSchema = z.object({
  scope: z.literal("board:inspect"),
  sessionId: z.string().min(1),
  boardId: z.string().min(1),
  expiresAtMs: z.number().int().positive(),
});

type InspectionTokenPayload = z.infer<typeof inspectionTokenPayloadSchema>;
type BoardInspectionTokenPayload = Omit<InspectionTokenPayload, "expiresAtMs"> & {
  expiresAtMs: number;
};
export const BOARD_INSPECTION_TOKEN_PREFIX = "bi1.";

export type BoardInspectionTokenError = "expired" | "invalid" | "scope_mismatch";

export async function mintBoardInspectionToken(
  payload: Omit<BoardInspectionTokenPayload, "scope">,
  secret: string
): Promise<string> {
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ scope: "board:inspect", ...payload }))
  );
  const signature = await sign(encodedPayload, secret);
  return `${BOARD_INSPECTION_TOKEN_PREFIX}${encodedPayload}.${encodeBase64Url(signature)}`;
}

export async function verifyBoardInspectionToken(
  token: string,
  secret: string,
  expected: { sessionId: string; boardId: string; nowMs: number }
): Promise<{ ok: true } | { ok: false; error: BoardInspectionTokenError }> {
  if (!token.startsWith(BOARD_INSPECTION_TOKEN_PREFIX)) return { ok: false, error: "invalid" };
  const [encodedPayload, encodedSignature, extra] = token
    .slice(BOARD_INSPECTION_TOKEN_PREFIX.length)
    .split(".");
  if (!encodedPayload || !encodedSignature || extra) return { ok: false, error: "invalid" };

  try {
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload)
    );
    if (!valid) return { ok: false, error: "invalid" };

    const payload = inspectionTokenPayloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)))
    );
    if (!payload.success) return { ok: false, error: "invalid" };
    const expiresAtMs = payload.data.expiresAtMs;
    if (expiresAtMs < expected.nowMs) return { ok: false, error: "expired" };
    if (
      payload.data.sessionId !== expected.sessionId ||
      payload.data.boardId !== expected.boardId
    ) {
      return { ok: false, error: "scope_mismatch" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "invalid" };
  }
}

async function sign(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await hmacKey(secret, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

function hmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function encodeBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
