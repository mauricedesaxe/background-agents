export type LocalDateTimeResolution =
  | { ok: true; instant: Date }
  | { ok: false; reason: "invalid" | "nonexistent" | "ambiguous" };

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function resolveLocalDateTime(value: string, timeZone: string): LocalDateTimeResolution {
  const local = parseLocalDateTime(value);
  if (!local || !isValidTimeZone(timeZone)) return { ok: false, reason: "invalid" };
  const wallClockUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(wallClockUtc + hours * 60 * 60 * 1000);
    offsets.add(timeZoneOffsetMs(sample, timeZone));
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallClockUtc - offset))
    .filter((candidate) => localPartsEqual(formatLocalParts(candidate, timeZone), local));
  const unique = [
    ...new Map(candidates.map((candidate) => [candidate.getTime(), candidate])).values(),
  ];
  if (unique.length === 0) return { ok: false, reason: "nonexistent" };
  if (unique.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, instant: unique[0] };
}

export function tomorrowMorning(timeZone: string, now = new Date()): LocalDateTimeResolution {
  const today = formatLocalParts(now, timeZone);
  const tomorrowUtc = new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 9, 0));
  return resolveLocalDateTime(
    `${tomorrowUtc.getUTCFullYear()}-${pad(tomorrowUtc.getUTCMonth() + 1)}-${pad(
      tomorrowUtc.getUTCDate()
    )}T09:00`,
    timeZone
  );
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function parseLocalDateTime(value: string): LocalParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

function formatLocalParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const local = formatLocalParts(date, timeZone);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - date.getTime()
  );
}

function localPartsEqual(left: LocalParts, right: LocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
