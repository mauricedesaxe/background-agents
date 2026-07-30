import type { SpawnSource } from "@open-inspect/shared";

const SESSION_AUTO_ARCHIVE_DELAY_MS = 12 * 60 * 60 * 1000;
const AUTOMATION_SESSION_AUTO_ARCHIVE_DELAY_MS = 60 * 60 * 1000;

export function getSessionAutoArchiveDelayMs(spawnSource: SpawnSource): number {
  return spawnSource === "automation"
    ? AUTOMATION_SESSION_AUTO_ARCHIVE_DELAY_MS
    : SESSION_AUTO_ARCHIVE_DELAY_MS;
}

export function getSandboxAutoArchiveIntervalMinutes(spawnSource: SpawnSource): number {
  return getSessionAutoArchiveDelayMs(spawnSource) / (60 * 1000);
}
