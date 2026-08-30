import { describe, expect, it } from "@effect/vitest";

import { parseCursorUsageEvent } from "./cursorUsage.ts";

describe("parseCursorUsageEvent", () => {
  it("maps dashboard token usage into a cursor UsageRecord", () => {
    const record = parseCursorUsageEvent({
      timestamp: "1787669829247",
      model: "default",
      conversationId: "conv-1",
      isTokenBasedCall: true,
      chargedCents: 0,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        totalCents: 12.5,
      },
    });

    expect(record).toEqual({
      provider: "cursor",
      timestampMs: 1787669829247,
      model: "default",
      sessionId: "conv-1",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 200,
        cacheCreationTokens: 50,
        outputTokens: 40,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.125,
      dedupeKey: "1787669829247:conv-1:default",
    });
  });

  it("skips non-token events and empty payloads", () => {
    expect(
      parseCursorUsageEvent({
        timestamp: "1",
        model: "default",
        isTokenBasedCall: false,
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toBeNull();

    expect(
      parseCursorUsageEvent({
        timestamp: "1",
        model: "default",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    ).toBeNull();
  });
});
