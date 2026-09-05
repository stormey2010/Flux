import { describe, expect, it, vi } from "vite-plus/test";
import { TurnId } from "@t3tools/contracts";

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: unknown }) => children,
}));

import {
  shouldKeepAuthoritativeQueuedMessage,
  shouldKeepOptimisticQueuedMessage,
  shouldRemoveOptimisticQueuedMessage,
} from "./ChatView";

describe("authoritative queued message reconciliation", () => {
  it("keeps a server row queued until it has been assigned a turn", () => {
    expect(shouldKeepAuthoritativeQueuedMessage({ deliveryState: "queued", turnId: null })).toBe(
      true,
    );
  });

  it("removes a server row from the queue once it has been assigned a turn", () => {
    expect(
      shouldKeepAuthoritativeQueuedMessage({
        deliveryState: "queued",
        turnId: TurnId.make("turn-accepted"),
      }),
    ).toBe(false);
  });
});

describe("optimistic queued message reconciliation", () => {
  it("keeps the optimistic row while message-sent is still ahead of turn-queued", () => {
    expect(
      shouldRemoveOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: undefined, turnId: null },
      ),
    ).toBe(false);
  });

  it("releases the optimistic row once the server owns the queued message", () => {
    expect(
      shouldRemoveOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: "queued", turnId: null },
      ),
    ).toBe(true);
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

  it("does not let the optimistic row mask an accepted server copy", () => {
    expect(
      shouldKeepOptimisticQueuedMessage(
        { deliveryState: "queued" },
        { deliveryState: undefined, turnId: TurnId.make("turn-accepted") },
      ),
    ).toBe(false);
  });
});
