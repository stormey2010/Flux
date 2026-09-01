import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-queue-test");
const MESSAGE_ID = MessageId.make("message-queue-test");
const TURN_ID = TurnId.make("turn-active-test");

function makeReadModel(
  options: {
    readonly queued?: boolean;
    readonly running?: boolean;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-queue-test"),
        title: "Queue test",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: options.queued
          ? [
              {
                id: MESSAGE_ID,
                role: "user",
                text: "Run this next",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
                deliveryState: "queued",
              },
            ]
          : [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: options.running
          ? {
              threadId: THREAD_ID,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: TURN_ID,
              lastError: null,
              updatedAt: NOW,
            }
          : null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("queued and steered turns", (it) => {
  it.effect("emits a durable queue intent for Run Next", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-queue-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MESSAGE_ID,
            role: "user",
            text: "Run this next",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          deliveryMode: "after-current",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-queued",
      ]);
    }),
  );

  it.effect("uses the explicit enqueue command for Send while a turn runs", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.enqueue",
          commandId: CommandId.make("cmd-explicit-queue-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-explicit-queue"),
            role: "user",
            text: "This must wait",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ running: true }),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-queued",
      ]);
    }),
  );

  it.effect("emits native steering only for the expected active turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.make("cmd-steer-turn"),
          threadId: THREAD_ID,
          expectedTurnId: TURN_ID,
          message: {
            messageId: MESSAGE_ID,
            role: "user",
            text: "Change direction",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: makeReadModel({ running: true }),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-steer-requested",
      ]);
      const failure = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.steer",
            commandId: CommandId.make("cmd-stale-steer"),
            threadId: THREAD_ID,
            expectedTurnId: TurnId.make("turn-stale"),
            message: {
              messageId: MessageId.make("message-stale-steer"),
              role: "user",
              text: "Stale",
              attachments: [],
            },
            createdAt: NOW,
          },
          readModel: makeReadModel({ running: true }),
        }),
      );
      expect(failure._tag).toBe("Failure");
    }),
  );

  it.effect("cancels only messages that remain queued", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.cancel",
          commandId: CommandId.make("cmd-cancel-queued-turn"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel({ queued: true }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-turn-cancelled"]);
    }),
  );

  it.effect("edits only messages that remain queued", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.edit",
          commandId: CommandId.make("cmd-edit-queued-turn"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          text: "Updated queued request",
          createdAt: NOW,
        },
        readModel: makeReadModel({ queued: true }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-turn-edited"]);
      expect(events[0]?.payload).toMatchObject({
        messageId: MESSAGE_ID,
        text: "Updated queued request",
      });
    }),
  );

  it.effect("requires reorder to be a complete permutation of queued messages", () =>
    Effect.gen(function* () {
      const secondMessageId = MessageId.make("message-queue-test-2");
      const readModel = makeReadModel({ queued: true });
      const thread = readModel.threads[0]!;
      const readModelWithTwoQueued = {
        ...readModel,
        threads: [
          {
            ...thread,
            messages: [
              ...thread.messages,
              {
                ...thread.messages[0]!,
                id: secondMessageId,
                text: "Run this after the first queued message",
              },
            ],
          },
        ],
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.reorder",
          commandId: CommandId.make("cmd-reorder-queued-turn"),
          threadId: THREAD_ID,
          messageIds: [secondMessageId, MESSAGE_ID],
          createdAt: NOW,
        },
        readModel: readModelWithTwoQueued,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-turn-reordered"]);
      expect(events[0]?.payload).toMatchObject({
        threadId: THREAD_ID,
        messageIds: [secondMessageId, MESSAGE_ID],
      });

      const rejected = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.queued-turn.reorder",
            commandId: CommandId.make("cmd-reorder-queued-turn-invalid"),
            threadId: THREAD_ID,
            messageIds: [MESSAGE_ID],
            createdAt: NOW,
          },
          readModel: readModelWithTwoQueued,
        }),
      );
      expect(rejected._tag).toBe("Failure");
    }),
  );

  it.effect("promotes a queued message to a steer request without duplicating it", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.steer",
          commandId: CommandId.make("cmd-steer-queued-turn"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          expectedTurnId: TURN_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel({ queued: true, running: true }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-turn-steer-requested"]);
      expect(events[0]?.payload).toMatchObject({
        messageId: MESSAGE_ID,
        expectedTurnId: TURN_ID,
      });
    }),
  );

  it.effect("emits explicit queued-turn outcome and resume events", () =>
    Effect.gen(function* () {
      const accepted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.accept",
          commandId: CommandId.make("cmd-queue-accept"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          turnId: TURN_ID,
          acceptedAt: NOW,
        },
        readModel: makeReadModel({ queued: true }),
      });
      expect((Array.isArray(accepted) ? accepted : [accepted]).map((event) => event.type)).toEqual([
        "thread.queued-turn-accepted",
      ]);

      const failed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.fail",
          commandId: CommandId.make("cmd-queue-fail"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          failedAt: NOW,
        },
        readModel: makeReadModel({ queued: true }),
      });
      expect((Array.isArray(failed) ? failed : [failed]).map((event) => event.type)).toEqual([
        "thread.queued-turn-failed",
      ]);

      const resumed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queued-turn.resume",
          commandId: CommandId.make("cmd-queue-resume"),
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel({ queued: true }),
      });
      expect((Array.isArray(resumed) ? resumed : [resumed]).map((event) => event.type)).toEqual([
        "thread.queued-turn-resumed",
      ]);
    }),
  );
});
