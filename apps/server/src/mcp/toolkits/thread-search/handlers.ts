import {
  ThreadSearchMcpFailure,
  type ThreadSearchMcpInput,
  type ThreadSearchMcpResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadSearchToolkit } from "./tools.ts";

const failure = (
  code: ThreadSearchMcpFailure["code"],
  message: string,
): ThreadSearchMcpFailure => ({ code, message });

const search = (input: ThreadSearchMcpInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const query = yield* ProjectionSnapshotQuery;
    const caller = yield* query
      .getThreadShellById(scope.threadId)
      .pipe(
        Effect.mapError(() => failure("search_error", "Unable to resolve the calling thread.")),
      );
    if (caller._tag === "None") {
      return yield* Effect.fail(
        failure("thread_not_found", "The calling thread is no longer available."),
      );
    }

    const searchThreadContent = query.searchThreadContent;
    if (searchThreadContent === undefined) {
      return yield* Effect.fail(failure("search_error", "Thread search is unavailable."));
    }

    const page = yield* searchThreadContent({
      projectId: caller.value.projectId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      query: input.query,
      includeArchived: input.includeArchived === true,
      offset: input.cursor ?? 0,
      limit: input.limit ?? 20,
      snippetChars: input.snippetChars ?? 240,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ProjectionThreadContentSearchInputError"
          ? failure("invalid_request", error.message)
          : failure("search_error", "Unable to search thread content."),
      ),
    );

    return {
      projectId: caller.value.projectId,
      hits: page.hits.map((hit) => ({
        ...hit,
        readAnchor:
          hit.messageId === null
            ? null
            : { sourceThreadId: hit.threadId, messageId: hit.messageId },
      })),
      nextCursor: page.nextOffset,
      hasMore: page.hasMore,
      traversalTruncated: false,
      consistency: "live" as const,
    } satisfies ThreadSearchMcpResult;
  });

const handlers = {
  t3_thread_search: search,
} satisfies Parameters<typeof ThreadSearchToolkit.toLayer>[0];

export const ThreadSearchToolkitHandlersLive = ThreadSearchToolkit.toLayer(handlers);
