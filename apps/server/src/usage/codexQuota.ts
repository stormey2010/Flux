/**
 * Codex plan/rate-limit snapshot for the sidebar Usage popup.
 *
 * Spawns a short-lived `codex app-server`, calls `account/rateLimits/read`, then
 * exits. Results are meant to be cached by the caller (~1 min).
 *
 * @module codexQuota
 */
import type { UsageQuotaMeter, UsageQuotaProvider } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";

import { expandHomePath } from "../pathExpansion.ts";
import { codexAppServerArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as ServerSettings from "../serverSettings.ts";

const CODEX_QUOTA_TIMEOUT = Duration.seconds(20);
const CODEX_FORCE_KILL_AFTER = "3 seconds" as const;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function windowLabel(windowDurationMins: number | null | undefined): string {
  if (typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins)) {
    return "Window";
  }
  if (windowDurationMins <= 360) return "5-hour";
  if (windowDurationMins <= 60 * 24 * 3) return "Daily";
  return "Weekly";
}

function resetsAtIso(resetsAt: number | null | undefined): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const ms = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function meterFromWindow(
  id: string,
  window: {
    readonly usedPercent: number;
    readonly resetsAt?: number | null;
    readonly windowDurationMins?: number | null;
  },
): UsageQuotaMeter {
  const usedPercent = clampPercent(window.usedPercent);
  return {
    id,
    label: windowLabel(window.windowDurationMins),
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    detail: null,
    resetsAt: resetsAtIso(window.resetsAt),
  };
}

const readCodexRateLimits = Effect.fn("usage.readCodexRateLimits")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolved = yield* settings.getSettings;
  const codex = resolved.providers.codex;
  const binaryPath = codex.binaryPath?.trim() || "codex";
  const homePath = codex.homePath?.trim() ? expandHomePath(codex.homePath.trim()) : undefined;
  const cwd = process.cwd();
  const environment = {
    ...process.env,
    ...(homePath ? { CODEX_HOME: homePath } : {}),
  };

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(
    binaryPath,
    codexAppServerArgs(codex.launchArgs ?? ""),
    {
      env: environment,
      extendEnv: true,
    },
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: environment,
      extendEnv: true,
      forceKillAfter: CODEX_FORCE_KILL_AFTER,
      shell: spawnCommand.shell,
    }),
  );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  yield* client.request("initialize", {
    clientInfo: {
      name: "t3code_desktop",
      title: "Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  yield* client.notify("initialized", undefined);

  const response = yield* client.request("account/rateLimits/read", undefined);
  const rateLimits = response.rateLimits;
  const meters: UsageQuotaMeter[] = [];

  if (rateLimits?.primary) {
    meters.push(meterFromWindow("primary", rateLimits.primary));
  }
  if (rateLimits?.secondary) {
    meters.push(meterFromWindow("secondary", rateLimits.secondary));
  }
  if (rateLimits?.credits) {
    const credits = rateLimits.credits;
    const balance =
      typeof credits.balance === "string" && credits.balance.trim().length > 0
        ? credits.balance.trim()
        : null;
    meters.push({
      id: "credits",
      label: "Credits",
      usedPercent: null,
      remainingPercent: null,
      detail: credits.unlimited
        ? "Unlimited"
        : balance !== null
          ? `${balance} available`
          : credits.hasCredits
            ? "Available"
            : "None",
      resetsAt: null,
    });
  }
  if (rateLimits?.individualLimit) {
    const limit = rateLimits.individualLimit;
    const remainingPercent = clampPercent(limit.remainingPercent);
    meters.push({
      id: "individual",
      label: "Billable usage",
      usedPercent: clampPercent(100 - remainingPercent),
      remainingPercent,
      detail: `${limit.used} of ${limit.limit}`,
      resetsAt: resetsAtIso(limit.resetsAt),
    });
  }

  const planLabel =
    typeof rateLimits?.planType === "string" && rateLimits.planType.trim().length > 0
      ? rateLimits.planType
      : null;

  return {
    provider: "codex" as const,
    status: "ok" as const,
    label: "Codex",
    planLabel,
    meters,
    message: meters.length === 0 ? "Codex did not report rate limits." : null,
  } satisfies UsageQuotaProvider;
});

/**
 * Soft-failing Codex quota probe for the Usage popup.
 */
export const fetchCodexQuota: Effect.Effect<
  UsageQuotaProvider,
  never,
  ServerSettings.ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = readCodexRateLimits().pipe(
  // The app-server child process and its JSON-RPC client own scoped resources.
  // Close them inside this soft-failing probe so one Codex problem cannot
  // reject the complete Usage RPC.
  Effect.scoped,
  Effect.timeoutOption(CODEX_QUOTA_TIMEOUT),
  Effect.map((result) =>
    Option.match(result, {
      onNone: () =>
        ({
          provider: "codex" as const,
          status: "failed" as const,
          label: "Codex",
          planLabel: null,
          meters: [],
          message: "Timed out while reading Codex rate limits.",
        }) satisfies UsageQuotaProvider,
      onSome: (value) => value,
    }),
  ),
  Effect.catch((error) =>
    Effect.succeed({
      provider: "codex" as const,
      status: "failed" as const,
      label: "Codex",
      planLabel: null,
      meters: [],
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim().slice(0, 240)
          : "Could not read Codex rate limits.",
    } satisfies UsageQuotaProvider),
  ),
);
