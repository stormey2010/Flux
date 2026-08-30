import { type GeminiSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { resolveGeminiBinaryPath } from "../provider/geminiCli.ts";
import { resolveGeminiCliModel } from "../provider/geminiModel.ts";

const Envelope = Schema.Struct({
  status: Schema.String,
  response: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
});

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeGeminiTextGeneration = Effect.fn("makeGeminiTextGeneration")(function* (
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly model: string;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const binaryPath = resolveGeminiBinaryPath(settings, environment);
      const jsonSchema = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        toJsonSchemaObject(input.outputSchema),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Could not encode the Gemini output schema.",
              cause,
            }),
        ),
      );
      const resolved = yield* resolveSpawnCommand(
        binaryPath,
        [
          "--input-format",
          "text",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchema,
          "--model",
          resolveGeminiCliModel(input.model, input.modelSelection) ?? input.model,
          "--print-timeout",
          "5m",
        ],
        { env: environment },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Could not resolve the Antigravity CLI command.",
              cause,
            }),
        ),
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: input.cwd,
            env: environment,
            shell: resolved.shell,
            stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Could not start the Antigravity CLI.",
                cause,
              }),
          ),
        );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout }),
          collectUint8StreamText({ stream: child.stderr }),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity output could not be read.",
              cause,
            }),
        ),
      );
      const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(Envelope))(
        stdout.text.trim(),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity returned invalid JSON.",
              cause,
            }),
        ),
      );
      if (code !== 0 || envelope.status.toUpperCase() !== "SUCCESS") {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            envelope.error?.trim() || stderr.text.trim() || `Antigravity exited with code ${code}.`,
        });
      }
      const decodeOutput =
        envelope.structured_output !== undefined
          ? Schema.decodeUnknownEffect(input.outputSchema)(envelope.structured_output)
          : Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(envelope.response ?? "");
      return yield* decodeOutput.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity returned structured output in an unexpected shape.",
              cause,
            }),
        ),
      );
    }).pipe(Effect.scoped);

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("GeminiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        model: input.modelSelection.model,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("GeminiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        model: input.modelSelection.model,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("GeminiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        model: input.modelSelection.model,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("GeminiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        model: input.modelSelection.model,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
