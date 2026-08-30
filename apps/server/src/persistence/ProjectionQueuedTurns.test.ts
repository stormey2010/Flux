import { CommandId, EventId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProjectionQueuedTurnRepository,
  ProjectionQueuedTurnRepositoryLive,
} from "./ProjectionQueuedTurns.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const layer = it.layer(
  ProjectionQueuedTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionQueuedTurnRepository", (it) => {
  it.effect("keeps FIFO order and transitions a row exactly once", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionQueuedTurnRepository;
      const threadId = ThreadId.make("thread-queue-repository");
      const base = {
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        titleSeed: null,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
      };
      const first = {
        ...base,
        messageId: MessageId.make("queue-first"),
        eventId: EventId.make("event-first"),
        commandId: CommandId.make("command-first"),
        queuedAt: "2026-08-16T12:00:00.000Z",
        eventSequence: 2,
        status: "queued" as const,
      };
      const second = {
        ...base,
        messageId: MessageId.make("queue-second"),
        eventId: EventId.make("event-second"),
        commandId: CommandId.make("command-second"),
        queuedAt: "2026-08-16T11:59:00.000Z",
        eventSequence: 1,
        status: "queued" as const,
      };

      yield* repository.upsert(first);
      yield* repository.upsert(second);
      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(
        rows.map((row) => row.messageId),
        [second.messageId, first.messageId],
      );

      yield* repository.markHandoff({ messageId: first.messageId });
      yield* repository.markHandoff({ messageId: first.messageId });
      const transitioned = yield* repository.listByThreadId({ threadId });
      assert.equal(
        transitioned.find((row) => row.messageId === first.messageId)?.status,
        "handoff",
      );
      assert.equal(
        transitioned.find((row) => row.messageId === second.messageId)?.status,
        "queued",
      );

      yield* repository.deleteByMessageId({ messageId: second.messageId });
      assert.equal((yield* repository.listByThreadId({ threadId })).length, 1);
    }),
  );
});
