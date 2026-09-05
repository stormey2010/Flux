import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueueStack } from "./ComposerQueueStack";

const items = [
  { id: MessageId.make("first"), text: "first queued request" },
  { id: MessageId.make("second"), text: "second queued request" },
];
const firstItem = items[0]!;

describe("ComposerQueueStack", () => {
  it("renders the compact queue in order with Flux action labels", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueueStack
        items={items}
        canSteer
        onSteer={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(markup).toContain('data-chat-composer-queue="true"');
    expect(markup).toContain("2 waiting");
    expect(markup).toContain("Runs next");
    expect(markup).toContain("max-h-[30dvh]");
    expect(markup).toContain('aria-label="Steer"');
    expect(markup).toContain('aria-label="Delete queued message"');
    expect(markup).toContain('aria-label="Queued message actions"');
    expect(markup).not.toContain("textarea");
    expect(markup.indexOf("first queued request")).toBeLessThan(
      markup.indexOf("second queued request"),
    );
    expect(markup.indexOf('aria-label="Steer"')).toBeLessThan(
      markup.indexOf('aria-label="Delete queued message"'),
    );
  });

  it("renders interruption and failed-message wording without an inline editor", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueueStack
        items={[
          {
            ...firstItem,
            pausedReason: "send-failed",
            imagePreviewSrc: "data:image/png;base64,abc",
          },
        ]}
        canSteer
        isInterrupted
        onResumeInterruptedQueue={() => {}}
        onSteer={() => {}}
        onRetry={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(markup).toContain("Queue paused because you interrupted");
    expect(markup).toContain(">Resume<");
    expect(markup).toContain('aria-label="Retry"');
    expect(markup).toContain('alt="Image attachment"');
    expect(markup).toContain('aria-label="Queued message actions"');
  });

  it("does not render when the durable queue is empty", () => {
    expect(
      renderToStaticMarkup(
        <ComposerQueueStack
          items={[]}
          canSteer={false}
          onSteer={() => {}}
          onCancel={() => {}}
          onEdit={() => {}}
        />,
      ),
    ).toBe("");
  });
});
