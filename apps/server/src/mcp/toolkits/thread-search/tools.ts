import {
  ThreadSearchMcpFailure,
  ThreadSearchMcpInput,
  ThreadSearchMcpResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const ThreadSearchTool = Tool.make("t3_thread_search", {
  description:
    "Search durable thread titles and visible user or assistant messages in the calling thread's project. Archived threads are excluded unless includeArchived is true; deleted threads and other projects are never searched. Results and snippets are bounded, and a returned readAnchor identifies a matching message.",
  parameters: ThreadSearchMcpInput,
  success: ThreadSearchMcpResult,
  failure: ThreadSearchMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, ProjectionSnapshotQuery],
})
  .annotate(Tool.Title, "Search Flux threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSearchToolkit = Toolkit.make(ThreadSearchTool);
