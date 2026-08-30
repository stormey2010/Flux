import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";

const unicodeCodePointLength = (minimum: number, maximum: number) =>
  Schema.makeFilter((value: string) => {
    const length = Array.from(value).length;
    return length >= minimum && length <= maximum
      ? true
      : `Expected between ${minimum} and ${maximum} Unicode code points.`;
  });

export const ThreadSearchMcpInput = Schema.Struct({
  query: Schema.String.check(unicodeCodePointLength(2, 200)),
  threadId: Schema.optional(ThreadId),
  includeArchived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  snippetChars: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 1_000 })),
  ),
});
export type ThreadSearchMcpInput = typeof ThreadSearchMcpInput.Type;

export const ThreadSearchMcpHit = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String.check(unicodeCodePointLength(0, 500)),
  threadTitleTruncated: Schema.Boolean,
  archived: Schema.Boolean,
  source: Schema.Literals(["title", "user", "assistant"]),
  origin: Schema.Literal("legacy"),
  snippet: Schema.String.check(unicodeCodePointLength(0, 1_000)),
  snippetTruncated: Schema.Boolean,
  matchedAt: IsoDateTime,
  messageId: Schema.NullOr(MessageId),
  readAnchor: Schema.NullOr(Schema.Struct({ sourceThreadId: ThreadId, messageId: MessageId })),
});
export type ThreadSearchMcpHit = typeof ThreadSearchMcpHit.Type;

export const ThreadSearchMcpResult = Schema.Struct({
  projectId: ProjectId,
  hits: Schema.Array(ThreadSearchMcpHit),
  nextCursor: Schema.NullOr(Schema.Int),
  hasMore: Schema.Boolean,
  traversalTruncated: Schema.Boolean,
  consistency: Schema.Literal("live"),
});
export type ThreadSearchMcpResult = typeof ThreadSearchMcpResult.Type;

export const ThreadSearchMcpFailure = Schema.Struct({
  code: Schema.Literals(["invalid_request", "thread_not_found", "search_error"]),
  message: Schema.String,
});
export type ThreadSearchMcpFailure = typeof ThreadSearchMcpFailure.Type;
