import {
  type GeminiSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveGeminiBinaryPath } from "../geminiCli.ts";
import { geminiCapabilitiesForEfforts, groupGeminiModels } from "../geminiModel.ts";

const PRESENTATION = {
  displayName: "Gemini",
  badgeLabel: "New",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    isCustom: false,
    capabilities: geminiCapabilitiesForEfforts(["high", "medium", "low"]),
  },
  {
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: geminiCapabilitiesForEfforts(["high", "low"]),
  },
];

const PROBE_TIMEOUT_MS = 15_000;

const modelsFromSettings = (
  settings: GeminiSettings,
  builtInModels: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
) => providerModelsFromSettings(builtInModels, settings.customModels, EMPTY_CAPABILITIES);

export function parseAntigravityModels(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const line of output.split(/\r?\n/u)) {
    // `agy models` uses a tab in current releases and spaces in older ones.
    const match = line.trim().match(/^(gemini-[a-z0-9][a-z0-9.-]*)\s+(.+)$/iu);
    if (!match) continue;
    const slug = match[1]!.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: match[2]!.trim(),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return groupGeminiModels(models);
}

const run = (
  settings: GeminiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binaryPath = resolveGeminiBinaryPath(settings, environment);
    const resolved = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
        stdin: "ignore",
      }),
    );
  });

const looksUnauthenticated = (output: string) =>
  /authentication required|not authenticated|sign[ -]?in required|log[ -]?in required/iu.test(
    output,
  );

export const buildInitialGeminiProviderSnapshot = Effect.fn("buildInitialGeminiProviderSnapshot")(
  function* (settings: GeminiSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Google Antigravity CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Gemini is disabled in Code settings.",
          },
    });
  },
);

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings);
  if (!settings.enabled) {
    return yield* buildInitialGeminiProviderSnapshot(settings);
  }

  const versionResult = yield* run(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const cause = versionResult.failure;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(cause)
          ? "Google Antigravity CLI (`agy`) is not installed or is not on PATH."
          : "Could not run the Google Antigravity CLI.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Google Antigravity CLI timed out while checking its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  const modelsResult = yield* run(settings, ["models"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Antigravity is installed, but Code could not load its Gemini models.",
      },
    });
  }

  const modelOutput = modelsResult.success.value;
  const combined = `${modelOutput.stdout}\n${modelOutput.stderr}`;
  if (modelOutput.code !== 0 && looksUnauthenticated(combined)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          "Sign in required. Run `agy` once and use the Google account tied to your AI Pro or Ultra subscription.",
      },
    });
  }

  const discovered = parseAntigravityModels(modelOutput.stdout);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: modelsFromSettings(settings, discovered.length > 0 ? discovered : FALLBACK_MODELS),
    probe: {
      installed: true,
      version,
      status: modelOutput.code === 0 ? "ready" : "warning",
      auth: { status: modelOutput.code === 0 ? "authenticated" : "unknown" },
      ...(modelOutput.code === 0
        ? {}
        : { message: "Antigravity is installed, but model discovery returned an error." }),
    },
  });
});
