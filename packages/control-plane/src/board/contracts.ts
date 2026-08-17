/**
 * Contract constants for the BoardRoom Durable Object's internal HTTP surface.
 * The worker board routes and the DO both import these to prevent path drift.
 * The browser sync connection is a WebSocket upgrade (any path with an `Upgrade`
 * header), not one of these paths.
 */
export const BoardInternalPaths = {
  mutate: "/internal/mutate",
  snapshot: "/internal/snapshot",
} as const;

export type BoardInternalPath = (typeof BoardInternalPaths)[keyof typeof BoardInternalPaths];

const BOARD_INTERNAL_ORIGIN = "http://board";

export function buildBoardInternalUrl(path: BoardInternalPath): string {
  return `${BOARD_INTERNAL_ORIGIN}${path}`;
}
