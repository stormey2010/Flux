import {
  EventId,
  type GeminiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { resolveGeminiBinaryPath } from "../geminiCli.ts";
import { resolveGeminiCliModel } from "../geminiModel.ts";

const PROVIDER = ProviderDriverKind.make("gemini");
const RESUME_VERSION = 1 as const;

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  thinking_tokens: Schema.optional(Schema.Number),
  cache_read_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
});

const StepUpdate = Schema.Struct({
  conversation_id: Schema.optional(Schema.String),
  step_index: Schema.Number,
  state: Schema.String,
  step_type: Schema.String,
  tool_name: Schema.optional(Schema.String),
  text_delta: Schema.optional(Schema.String),
  duration_seconds: Schema.optional(Schema.Number),
  usage: Schema.optional(Usage),
  tool_info: Schema.optional(Schema.Unknown),
  subagent_info: Schema.optional(Schema.Unknown),
});

const ResultPayload = Schema.Struct({
  conversation_id: Schema.String,
  status: Schema.String,
  response: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  duration_seconds: Schema.optional(Schema.Number),
  num_turns: Schema.optional(Schema.Number),
  usage: Schema.optional(Usage),
});

const AntigravityEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("init"),
    conversation_id: Schema.String,
    init: Schema.Unknown,
  }),
  Schema.Struct({ event: Schema.Literal("step_update"), step_update: StepUpdate }),
  Schema.Struct({ event: Schema.Literal("result"), result: ResultPayload }),
]);
type AntigravityEvent = typeof AntigravityEvent.Type;

export function decodeAntigravityEvent(line: string): AntigravityEvent | undefined {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(AntigravityEvent))(line);
  } catch {
    return undefined;
  }
}

function parseResumeCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return record.schemaVersion === RESUME_VERSION &&
    typeof record.conversationId === "string" &&
    record.conversationId.trim().length > 0
    ? record.conversationId.trim()
    : undefined;
}

function asResumeCursor(conversationId: string) {
  return { schemaVersion: RESUME_VERSION, conversationId } as const;
}

function toolItemType(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("command") || normalized.includes("terminal")) {
    return "command_execution" as const;
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("file")) {
    return "file_change" as const;
  }
  if (normalized.includes("search") || normalized.includes("browser")) {
    return "web_search" as const;
  }
  if (normalized.includes("agent")) return "collab_agent_tool_call" as const;
  return "dynamic_tool_call" as const;
}

interface GeminiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface GeminiSessionContext {
  session: ProviderSession;
  conversationId: string | undefined;
  activeProcess: ChildProcessHandle | undefined;
  readonly turns: Array<GeminiTurnSnapshot>;
  readonly startedToolItems: Set<string>;
  stopped: boolean;
}

export interface GeminiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  settings: GeminiSettings,
  options?: GeminiAdapterOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, GeminiSessionContext>();
  const environment = options?.environment ?? process.env;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("gemini");

  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not generate a Gemini runtime identifier.",
          cause,
        }),
    ),
  );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const stamp = () =>
    Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required and must be non-empty.",
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing?.activeProcess) yield* existing.activeProcess.kill().pipe(Effect.ignore);
      const createdAt = yield* nowIso;
      const conversationId = parseResumeCursor(input.resumeCursor);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd.trim(),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        threadId: input.threadId,
        ...(conversationId ? { resumeCursor: asResumeCursor(conversationId) } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        conversationId,
        activeProcess: undefined,
        turns: [],
        startedToolItems: new Set(),
        stopped: false,
      });
      yield* emit({
        type: "session.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: {
          message: "Google Antigravity session ready",
          ...(conversationId ? { resume: asResumeCursor(conversationId) } : {}),
        },
      });
      yield* emit({
        type: "thread.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: conversationId ? { providerThreadId: conversationId } : {},
      });
      return session;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.activeProcess) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: "A Gemini turn is already running for this thread.",
        });
      }
      if (!input.input?.trim() && (!input.attachments || input.attachments.length === 0)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }

      const attachmentPaths: string[] = [];
      for (const attachment of input.attachments ?? []) {
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!path) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        attachmentPaths.push(path);
      }
      const prompt = [
        input.input?.trim() ?? "Please inspect the attached files.",
        attachmentPaths.length > 0
          ? `\nAttached local files (read them from these paths):\n${attachmentPaths.map((path) => `- ${path}`).join("\n")}`
          : "",
      ].join("");

      const turnId = TurnId.make(yield* randomId);
      const model =
        input.modelSelection?.instanceId === boundInstanceId
          ? input.modelSelection.model
          : context.session.model;
      const cliModel = resolveGeminiCliModel(
        model,
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined,
      );
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        ...(model ? { model } : {}),
        updatedAt: yield* nowIso,
      };
      context.startedToolItems.clear();
      yield* emit({
        type: "turn.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        turnId,
        payload: model ? { model } : {},
      });

      const args = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--print-timeout",
        "30m",
      ];
      if (cliModel) args.push("--model", cliModel);
      if (context.conversationId) args.push("--conversation", context.conversationId);
      if (context.session.runtimeMode === "full-access") {
        args.push("--dangerously-skip-permissions");
      } else if (context.session.runtimeMode === "approval-required") {
        args.push("--sandbox");
      }

      const binaryPath = resolveGeminiBinaryPath(settings, environment);
      const resolved = yield* resolveSpawnCommand(binaryPath, args, { env: environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "resolveCommand",
              detail: "Could not resolve the Antigravity CLI command.",
              cause,
            }),
        ),
      );
      const inputLine = `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        event: "user",
        message: { content: prompt },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "encodePrompt",
              detail: "Could not encode the Gemini prompt.",
              cause,
            }),
        ),
      )}\n`;
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: context.session.cwd,
            env: environment,
            shell: resolved.shell,
            stdin: Stream.succeed(Buffer.from(inputLine, "utf8")),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "spawn",
                detail: "Could not start the Antigravity CLI. Install `agy` and sign in once.",
                cause,
              }),
          ),
        );
      context.activeProcess = child;
      const stderrRef = yield* Ref.make("");
      const assistantItemId = RuntimeItemId.make(`gemini-assistant-${turnId}`);
      let assistantStarted = false;
      let resultPayload: typeof ResultPayload.Type | undefined;

      const processEvent = (event: AntigravityEvent) =>
        Effect.gen(function* () {
          if (event.event === "init") {
            context.conversationId = event.conversation_id;
            context.session = {
              ...context.session,
              resumeCursor: asResumeCursor(event.conversation_id),
              updatedAt: yield* nowIso,
            };
            return;
          }
          if (event.event === "step_update") {
            const step = event.step_update;
            if (step.step_type === "agent_response" && step.text_delta !== undefined) {
              if (!assistantStarted) {
                assistantStarted = true;
                yield* emit({
                  type: "item.started",
                  ...(yield* stamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  turnId,
                  itemId: assistantItemId,
                  payload: { itemType: "assistant_message", status: "inProgress" },
                });
              }
              yield* emit({
                type: "content.delta",
                ...(yield* stamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                itemId: assistantItemId,
                payload: { streamKind: "assistant_text", delta: step.text_delta },
              });
              return;
            }
            if (step.step_type === "tool") {
              const key = String(step.step_index);
              const itemId = RuntimeItemId.make(`gemini-tool-${turnId}-${key}`);
              const toolName = step.tool_name ?? "Gemini tool";
              const started = context.startedToolItems.has(key);
              if (!started) context.startedToolItems.add(key);
              yield* emit({
                type:
                  step.state === "DONE"
                    ? "item.completed"
                    : started
                      ? "item.updated"
                      : "item.started",
                ...(yield* stamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                itemId,
                payload: {
                  itemType: toolItemType(toolName),
                  status: step.state === "DONE" ? "completed" : "inProgress",
                  title: toolName,
                  ...(step.tool_info === undefined ? {} : { data: step.tool_info }),
                },
              });
            }
            return;
          }

          resultPayload = event.result;
          context.conversationId = event.result.conversation_id || context.conversationId;
          if (context.conversationId) {
            context.session = {
              ...context.session,
              resumeCursor: asResumeCursor(context.conversationId),
            };
          }
          if (event.result.usage?.total_tokens !== undefined) {
            const usage = event.result.usage;
            const nonNegative = (value: number | undefined) =>
              value === undefined ? undefined : Math.max(0, Math.trunc(value));
            yield* emit({
              type: "thread.token-usage.updated",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId,
              payload: {
                usage: {
                  usedTokens: nonNegative(usage.total_tokens) ?? 0,
                  inputTokens: nonNegative(usage.input_tokens),
                  cachedInputTokens: nonNegative(usage.cache_read_tokens),
                  outputTokens: nonNegative(usage.output_tokens),
                  reasoningOutputTokens: nonNegative(usage.thinking_tokens),
                  durationMs:
                    event.result.duration_seconds === undefined
                      ? undefined
                      : Math.max(0, Math.trunc(event.result.duration_seconds * 1000)),
                },
              },
            });
          }
        });

      const stdoutEffect = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => line.trim()),
        Stream.filter((line) => line.length > 0),
        Stream.runForEach((line) => {
          const event = decodeAntigravityEvent(line);
          return event
            ? processEvent(event)
            : Effect.logDebug("Ignored unknown agy output", { line });
        }),
      );
      const stderrEffect = child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (current) => `${current}${chunk}`)),
      );
      const exitCode = yield* Effect.all([stdoutEffect, stderrEffect, child.exitCode], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(([, , code]) => Number(code)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "stream",
              detail: "The Antigravity CLI stream failed.",
              cause,
            }),
        ),
        Effect.ensuring(Effect.sync(() => (context.activeProcess = undefined))),
      );
      const stderr = (yield* Ref.get(stderrRef)).trim();

      if (assistantStarted) {
        yield* emit({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          itemId: assistantItemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
      const status = resultPayload?.status.toUpperCase();
      const state =
        status === "SUCCESS"
          ? "completed"
          : status === "CANCELED"
            ? "cancelled"
            : status === "INTERRUPTED"
              ? "interrupted"
              : "failed";
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        turnId,
        payload: {
          state,
          stopReason: status ?? (exitCode === 0 ? null : `exit ${exitCode}`),
          ...(resultPayload?.usage ? { usage: resultPayload.usage } : {}),
          ...(resultPayload?.error ? { errorMessage: resultPayload.error } : {}),
        },
      });
      context.session = {
        ...context.session,
        status: state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
        ...(state === "failed"
          ? {
              lastError:
                resultPayload?.error ?? (stderr || `Antigravity exited with code ${exitCode}.`),
            }
          : {}),
      };
      context.turns.push({ id: turnId, items: [{ prompt, result: resultPayload }] });

      if (state === "failed") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: resultPayload?.error ?? (stderr || `Antigravity exited with code ${exitCode}.`),
        });
      }
      return {
        threadId: input.threadId,
        turnId,
        ...(context.conversationId ? { resumeCursor: asResumeCursor(context.conversationId) } : {}),
      };
    }).pipe(Effect.scoped);

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (context.activeProcess) yield* context.activeProcess.kill().pipe(Effect.ignore);
    });

  const stopSessionInternal = (context: GeminiSessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      if (context.activeProcess) yield* context.activeProcess.kill().pipe(Effect.ignore);
      sessions.delete(context.session.threadId);
      yield* emit({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const unsupportedResponse = (method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: "Antigravity headless mode does not expose interactive approval responses.",
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
      Effect.tap(() => PubSub.shutdown(events)),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => unsupportedResponse("respondToRequest"),
    respondToUserInput: () => unsupportedResponse("respondToUserInput"),
    stopSession: (threadId) => Effect.flatMap(requireSession(threadId), stopSessionInternal),
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        return { threadId, turns: context.turns };
      }),
    stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
