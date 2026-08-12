/**
 * Branded time values.
 *
 * A point in time and a span of time are both `number` here, both in
 * milliseconds, and nothing stops you swapping them: `now > config.timeoutMs`
 * compiles as readily as `inactiveTime > config.timeoutMs`, and only one of them
 * means anything. An epoch timestamp compared against a ten-minute duration is
 * always true, which is a bug that reads correctly. These brands make the swap a
 * type error.
 *
 * Brands survive assignment but not arithmetic — `to - from` widens back to
 * plain `number` — so subtraction goes through `elapsed()` rather than being
 * written inline, and the result stays a `DurationMs` all the way to its
 * comparison.
 */

declare const epochMsBrand: unique symbol;
declare const durationMsBrand: unique symbol;

/** A point in time, as milliseconds since the Unix epoch. */
export type EpochMs = number & { readonly [epochMsBrand]: true };

/** A span of time, in milliseconds. */
export type DurationMs = number & { readonly [durationMsBrand]: true };

/** The current time. */
export function nowMs(): EpochMs {
  return Date.now() as EpochMs;
}

/**
 * Mint an `EpochMs` from a raw number.
 *
 * Call this where a timestamp enters the system — a database row, a request
 * body, a provider response. Calling it anywhere else defeats the brand, since
 * the whole point is that the value was checked once at the edge.
 */
export function epochMs(value: number): EpochMs {
  return value as EpochMs;
}

/** Mint a `DurationMs` from a raw number, for config values and literals. */
export function durationMs(value: number): DurationMs {
  return value as DurationMs;
}

/** The span from one point in time to another. Negative if `to` precedes `from`. */
export function elapsed(from: EpochMs, to: EpochMs): DurationMs {
  return (to - from) as DurationMs;
}

/** The point in time `span` after `from`. */
export function addDuration(from: EpochMs, span: DurationMs): EpochMs {
  return (from + span) as EpochMs;
}
