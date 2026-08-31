import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueueStack } from "./ComposerQueueStack";

const items = [
  { id: MessageId.make("first"), text: "first queued request" },
  { id: MessageId.make("second"), text: "second queued request" },
];

describe("ComposerQueueStack", () => {
  it("renders queued messages in order with individual actions", () => {
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
    expect(markup).toContain("2 messages waiting");
    expect(markup).toContain("Runs next");
    expect(markup).toContain("Edit queued message 1");
    expect(markup).not.toContain("FIFO");
    expect(markup.indexOf("first queued request")).toBeLessThan(
      markup.indexOf("second queued request"),
    );
    expect(markup).toContain("Steer queued message 1 now");
    expect(markup).toContain("Cancel queued message 2");
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
