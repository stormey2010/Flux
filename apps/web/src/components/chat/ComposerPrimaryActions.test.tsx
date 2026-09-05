import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderStandaloneStop() {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderRunningActions(hasSendableContent: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: TestEvent) => void>>();

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    child.parentNode = this;
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createElementNS(_namespace: string, name: string) {
    return new TestNode(name, this);
  }

  createTextNode() {
    return new TestNode("#text", this, 3);
  }

  addEventListener(type: string, listener: (event: TestEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: TestEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: TestEvent) {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles && !event.propagationStopped) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

type TestEvent = {
  bubbles: boolean;
  cancelable: boolean;
  currentTarget: TestNode | null;
  defaultPrevented: boolean;
  propagationStopped?: boolean;
  target: TestNode | null;
  type: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

function findSubmitButton(node: TestNode): TestNode {
  if (node.attributes.get("type") === "submit") return node;
  for (const child of node.childNodes) {
    try {
      return findSubmitButton(child);
    } catch {
      // Continue searching sibling nodes.
    }
  }
  throw new Error("Submit button not found");
}

function clickEvent(): TestEvent {
  const event: TestEvent = {
    bubbles: true,
    cancelable: true,
    currentTarget: null,
    defaultPrevented: false,
    propagationStopped: false,
    target: null,
    type: "click",
    preventDefault() {
      if (event.cancelable) event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
  };
  return event;
}

async function clickActiveTurnAction(activeTurnMessageBehavior: "queue" | "steer") {
  const document = installTestDom();
  const container = document.createElement("div");
  document.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const onQueue = vi.fn();
  const onSteer = vi.fn();

  try {
    await act(() => {
      root.render(
        createElement(ComposerPrimaryActions, {
          compact: true,
          pendingAction: null,
          isRunning: true,
          showPlanFollowUpPrompt: false,
          promptHasText: true,
          isSendBusy: false,
          sendDisabledReason: null,
          isConnecting: false,
          isEnvironmentUnavailable: false,
          isPreparingWorktree: false,
          hasSendableContent: true,
          activeTurnMessageBehavior,
          onQueue,
          onSteer,
          onPreviousPendingQuestion: () => {},
          onInterrupt: () => {},
          onImplementPlanInNewThread: () => {},
        }),
      );
    });

    const submitButton = findSubmitButton(container);
    await act(() => {
      submitButton.dispatchEvent(clickEvent());
    });
    return { onQueue, onSteer };
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("matches the small pending action size without changing the standalone size", () => {
    expect(renderPendingActions(true)).toContain("size-8 sm:size-7");
    expect(renderStandaloneStop()).toContain("size-8 sm:h-8 sm:w-8");
    expect(renderStandaloneStop()).not.toContain("sm:size-7");
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
    expect(markup).toContain("bg-transparent text-white");
    expect(markup).not.toContain("bg-message-action text-message-action-foreground");
  });

  it("keeps the normal send-button fill when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
    expect(markup).toContain("bg-message-action text-message-action-foreground");
  });

  it("renders queue alongside stop while running by default", () => {
    const markup = renderRunningActions(true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Queue message"');
  });

  it("renders queue as the active-turn action when configured", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        compact: true,
        pendingAction: null,
        isRunning: true,
        showPlanFollowUpPrompt: false,
        promptHasText: true,
        isSendBusy: false,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isPreparingWorktree: false,
        hasSendableContent: true,
        activeTurnMessageBehavior: "queue",
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onImplementPlanInNewThread: () => {},
      }),
    );

    expect(markup).toContain('aria-label="Queue message"');
  });

  it("keeps Send as queue with a legacy steering preference", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        compact: true,
        pendingAction: null,
        isRunning: true,
        showPlanFollowUpPrompt: false,
        promptHasText: true,
        isSendBusy: false,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isPreparingWorktree: false,
        hasSendableContent: true,
        activeTurnMessageBehavior: "steer",
        onQueue: () => {},
        onSteer: () => {},
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onImplementPlanInNewThread: () => {},
      }),
    );

    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).not.toContain("Steer message");
  });

  it("clicks onQueue for the active queue action", async () => {
    const { onQueue, onSteer } = await clickActiveTurnAction("queue");
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("queues even with a legacy steering preference", async () => {
    const { onQueue, onSteer } = await clickActiveTurnAction("steer");
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("keeps queue available while the previous send is being projected", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        compact: true,
        pendingAction: null,
        isRunning: true,
        showPlanFollowUpPrompt: false,
        promptHasText: true,
        isSendBusy: true,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isPreparingWorktree: false,
        hasSendableContent: true,
        activeTurnMessageBehavior: "queue",
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onImplementPlanInNewThread: () => {},
      }),
    );

    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('aria-label="Queue message"');
  });

  it("renders queue alongside stop while running by default", () => {
    const markup = renderRunningActions(true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).toContain('type="submit"');
    expect(markup).toContain("size-9 sm:size-8");
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    const markup = renderRunningActions(false);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });
});
