import { describe, expect, it } from "vitest";

import { formatReset } from "./SidebarUsagePopover";

describe("formatReset", () => {
  it("shows the exact local time when a quota resets today", () => {
    const now = new Date(2026, 7, 29, 9, 15);
    const reset = new Date(2026, 7, 29, 12, 40).toISOString();

    expect(formatReset(reset, now)).toBe(
      new Date(2026, 7, 29, 12, 40).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("shows the calendar date for a later reset", () => {
    const now = new Date(2026, 7, 29, 9, 15);
    const reset = new Date(2026, 8, 1, 12, 40).toISOString();

    expect(formatReset(reset, now)).toBe(
      new Date(2026, 8, 1, 12, 40).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
  });

  it("omits missing or invalid reset timestamps", () => {
    expect(formatReset(null)).toBeNull();
    expect(formatReset("not-a-date")).toBeNull();
  });
});
