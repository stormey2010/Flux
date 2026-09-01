import { describe, expect, it, vi } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: unknown }) => children,
}));

import { shouldRemoveOptimisticQueuedMessage } from "./ChatView";

describe("optimistic queued message reconciliation", () => {
  it("keeps the optimistic row while message-sent is still ahead of turn-queued", () => {
    expect(
      shouldRemoveOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: undefined, turnId: null },
      ),
    ).toBe(false);
  });

  it("keeps the optimistic row while the authoritative copy is still queued", () => {
    expect(
      shouldRemoveOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: "queued", turnId: null },
      ),
    ).toBe(false);
  });

  it("removes the optimistic row after queued-turn acceptance assigns a turn", () => {
    expect(
      shouldRemoveOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: undefined, turnId: TurnId.make("turn-accepted") },
      ),
    ).toBe(true);
  });

  it("does not remove an optimistic row until a matching server copy exists", () => {
    expect(shouldRemoveOptimisticQueuedMessage({ deliveryState: "queued" }, undefined)).toBe(false);
  });
});
