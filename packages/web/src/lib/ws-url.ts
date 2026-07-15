/**
 * Base URL of the control-plane WebSocket endpoint. `NEXT_PUBLIC_WS_URL` is
 * inlined at build time (Next.js), so this is a plain module constant, not a
 * runtime lookup. Single source of truth for the session socket and the board
 * sync socket.
 */
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";
