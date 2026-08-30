/**
 * Gemini/Antigravity plan snapshot for the sidebar Usage popup.
 *
 * Antigravity exposes its account quota through the official `/usage` slash
 * command (with `/quota` as an alias). The command is available in print mode,
 * which lets the desktop app show the same remaining percentages as the CLI.
 */
import type { UsageQuotaMeter, UsageQuotaProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveGeminiBinaryPath } from "../provider/geminiCli.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import * as ServerSettings from "../serverSettings.ts";

const GEMINI_QUOTA_TIMEOUT = Duration.seconds(15);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function parseGeminiUsageOutput(output: string): ReadonlyArray<UsageQuotaMeter> {
  const meters: UsageQuotaMeter[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^Gemini Models\s+(.+?)\s+(\d+(?:\.\d+)?)%\s+(\S+)$/iu);
    if (!match) continue;
    const remainingPercent = clampPercent(Number(match[2]));
    const periodLabel = match[1]!.trim();
    const parsedReset = Date.parse(match[3]!);
    const reset = Number.isFinite(parsedReset)
      ? DateTime.formatIso(DateTime.makeUnsafe(parsedReset))
      : null;
    meters.push({
      id: periodLabel
        .replace(/\s+limit\s+remaining$/iu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, ""),
      label: periodLabel.replace(/\s+limit\s+remaining$/iu, ""),
      usedPercent: clampPercent(100 - remainingPercent),
      remainingPercent,
      detail: `${remainingPercent}% remaining`,
      resetsAt: reset,
    });
  }
  return meters;
}

const readGeminiQuota = Effect.fn("usage.readGeminiQuota")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolved = yield* settings.getSettings;
  const gemini = resolved.providers.gemini;
  if (!gemini.enabled) {
    return {
      provider: "gemini" as const,
      status: "unavailable" as const,
      label: "Gemini",
      planLabel: null,
      meters: [],
      message: "Gemini is disabled in Code settings.",
    } satisfies UsageQuotaProvider;
  }

  const binaryPath = resolveGeminiBinaryPath(gemini, process.env);
  const command = yield* resolveSpawnCommand(
    binaryPath,
    ["--print", "/usage", "--output-format", "text"],
    { env: process.env },
  );
  const result = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(command.command, command.args, {
      env: process.env,
      shell: command.shell,
      stdin: "ignore",
    }),
  );
  const meters = parseGeminiUsageOutput(result.stdout);
  if (result.code !== 0 || meters.length === 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      provider: "gemini" as const,
      status: "failed" as const,
      label: "Gemini",
      planLabel: null,
      meters: [],
      message: detail
        ? detail.slice(0, 240)
        : "Antigravity did not return Gemini usage. Update `agy` and try again.",
    } satisfies UsageQuotaProvider;
  }
  return {
    provider: "gemini" as const,
    status: "ok" as const,
    label: "Gemini",
    planLabel: "Google account",
    meters,
    message: null,
  } satisfies UsageQuotaProvider;
});

export const fetchGeminiQuota: Effect.Effect<
  UsageQuotaProvider,
  never,
  ServerSettings.ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = readGeminiQuota().pipe(
  Effect.timeoutOption(GEMINI_QUOTA_TIMEOUT),
  Effect.map((result) =>
    Option.match(result, {
      onNone: () =>
        ({
          provider: "gemini" as const,
          status: "failed" as const,
          label: "Gemini",
          planLabel: null,
          meters: [],
          message: "Timed out while reading Gemini account limits.",
        }) satisfies UsageQuotaProvider,
      onSome: (value) => value,
    }),
  ),
  Effect.catch((error) =>
    Effect.succeed({
      provider: "gemini" as const,
      status: "failed" as const,
      label: "Gemini",
      planLabel: null,
      meters: [],
      message:
        error instanceof Error && error.message.trim()
          ? error.message.trim().slice(0, 240)
          : "Could not read Gemini account limits.",
    } satisfies UsageQuotaProvider),
  ),
);
