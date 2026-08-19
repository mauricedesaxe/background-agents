import { describe, expect, it } from "vitest";
import { resolveLocalDateTime, tomorrowMorning } from "./scheduling";

describe("resolveLocalDateTime", () => {
  it("resolves an ordinary local time to one instant", () => {
    const result = resolveLocalDateTime("2026-07-23T09:30", "Europe/London");
    expect(result).toEqual({ ok: true, instant: new Date("2026-07-23T08:30:00.000Z") });
  });

  it("rejects a daylight-saving gap", () => {
    expect(resolveLocalDateTime("2026-03-29T01:30", "Europe/London")).toEqual({
      ok: false,
      reason: "nonexistent",
    });
  });

  it("rejects a daylight-saving overlap", () => {
    expect(resolveLocalDateTime("2026-10-25T01:30", "Europe/London")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("rejects invalid timezones and calendar values", () => {
    expect(resolveLocalDateTime("2026-02-30T09:00", "Europe/London")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(resolveLocalDateTime("2026-07-23T09:00", "Mars/Olympus_Mons")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("tomorrowMorning", () => {
  it("uses 09:00 on the next local calendar day", () => {
    expect(tomorrowMorning("America/New_York", new Date("2026-07-23T23:00:00Z"))).toEqual({
      ok: true,
      instant: new Date("2026-07-24T13:00:00.000Z"),
    });
  });
});
