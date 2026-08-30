/**
 * Cursor usage via the dashboard filtered-events API.
 *
 * Cursor Agent does not write Claude/Codex-style local JSONL transcripts with
 * token counters. Instead, the signed-in Cursor app stores an access token in
 * its state database; we use that to call
 * `DashboardService/GetFilteredUsageEvents` and map events into the same
 * {@link UsageRecord} shape the transcript scanners produce.
 *
 * @module cursorUsage
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UsageQuotaMeter, UsageQuotaProvider, UsageSourceStatus } from "@t3tools/contracts";

import type { UsageRecord } from "./usageTranscripts.ts";

const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_FILTERED_USAGE_EVENTS_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents";
const CURSOR_CURRENT_PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_USAGE_PAGE_SIZE = 200;
const CURSOR_USAGE_MAX_PAGES = 50;
const CURSOR_USAGE_FETCH_TIMEOUT_MS = 30_000;

export const CURSOR_USAGE_SOURCE_PATH = "cursor://dashboard-api";

export type CursorUsageFetchResult = {
  readonly status: UsageSourceStatus;
  readonly records: readonly UsageRecord[];
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly malformedRecords: number;
  readonly message: string | null;
  readonly resolvedHomePath: string;
};

type CursorTokenUsage = {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly totalCents?: unknown;
};

type CursorUsageEvent = {
  readonly timestamp?: unknown;
  readonly model?: unknown;
  readonly conversationId?: unknown;
  readonly tokenUsage?: CursorTokenUsage | null;
  readonly chargedCents?: unknown;
  readonly isTokenBasedCall?: unknown;
};

type CursorFilteredUsageEventsResponse = {
  readonly totalUsageEventsCount?: unknown;
  readonly usageEventsDisplay?: unknown;
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolves Cursor IDE `state.vscdb` candidates (stable + Nightly).
 */
export function resolveCursorStateDbPaths(
  homeDirectory: string = NodeOs.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const bases: string[] = [];
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || NodePath.join(homeDirectory, "AppData", "Roaming");
    bases.push(appData);
  } else if (platform === "darwin") {
    bases.push(NodePath.join(homeDirectory, "Library", "Application Support"));
  } else {
    bases.push(env.XDG_CONFIG_HOME?.trim() || NodePath.join(homeDirectory, ".config"));
  }

  const paths: string[] = [];
  for (const base of bases) {
    for (const app of ["Cursor", "Cursor Nightly"] as const) {
      paths.push(NodePath.join(base, app, "User", "globalStorage", "state.vscdb"));
    }
  }
  return paths;
}

/**
 * Resolves the first existing Cursor IDE `state.vscdb` path.
 */
export function resolveCursorStateDbPath(
  homeDirectory: string = NodeOs.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = resolveCursorStateDbPaths(homeDirectory, platform, env);
  for (const candidate of candidates) {
    if (NodeFs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function normalizeAccessToken(value: string): string {
  return value
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/%3A%3A/gi, "::");
}

/**
 * Resolves a Cursor web-session JWT for the usage dashboard.
 *
 * Mirrors `cursor-usage`: `$CURSOR_SESSION_TOKEN` override, then the Cursor IDE
 * state DB (`cursorAuth/accessToken`). Agent API keys alone cannot read usage.
 */
export function resolveCursorAccessToken(input?: {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDbPath?: string;
}): { readonly token: string; readonly resolvedHomePath: string } | null {
  const env = input?.env ?? process.env;
  const override = env.CURSOR_SESSION_TOKEN?.trim();
  const stateDbPath =
    input?.stateDbPath ?? resolveCursorStateDbPath(input?.homeDirectory, input?.platform, env);

  if (override && override.length > 0) {
    const normalized = normalizeAccessToken(override);
    const jwt = normalized.includes("::") ? normalized.split("::").pop()! : normalized;
    if (jwt.length > 0) {
      return { token: jwt, resolvedHomePath: stateDbPath };
    }
  }

  for (const candidate of input?.stateDbPath
    ? [input.stateDbPath]
    : resolveCursorStateDbPaths(input?.homeDirectory, input?.platform, env)) {
    const token = readCursorAccessTokenFromStateDb(candidate);
    if (token !== null) {
      return { token, resolvedHomePath: candidate };
    }
  }

  return null;
}

/**
 * Reads `cursorAuth/accessToken` from a Cursor state database.
 *
 * Returns `null` when the DB is missing, unreadable, or the key is absent.
 * Never throws — callers treat that as "Cursor not signed in here".
 */
export function readCursorAccessTokenFromStateDb(dbPath: string): string | null {
  if (!NodeFs.existsSync(dbPath)) return null;

  let db: DatabaseSync | undefined;
  try {
    // Copy first when possible so a locked live DB still reads. Fall back to
    // opening the live path readonly if the copy fails (disk full, etc.).
    const copyPath = `${dbPath}.flux-usage-ro`;
    try {
      NodeFs.copyFileSync(dbPath, copyPath);
      db = new DatabaseSync(copyPath, { readOnly: true });
    } catch {
      db = new DatabaseSync(dbPath, { readOnly: true });
    }

    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(CURSOR_ACCESS_TOKEN_KEY) as { value?: unknown } | undefined;
    const value = row?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeAccessToken(value);
    }
    if (value instanceof Uint8Array) {
      const decoded = Buffer.from(value).toString("utf8");
      return decoded.trim().length > 0 ? normalizeAccessToken(decoded) : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
    try {
      NodeFs.unlinkSync(`${dbPath}.flux-usage-ro`);
    } catch {
      // ignore
    }
  }
}

/**
 * Maps one dashboard usage event into a {@link UsageRecord}, or `null` when
 * the event carries no usable token payload.
 */
export function parseCursorUsageEvent(event: CursorUsageEvent): UsageRecord | null {
  if (event.isTokenBasedCall === false) return null;

  const tokenUsage = event.tokenUsage;
  if (typeof tokenUsage !== "object" || tokenUsage === null) return null;

  const timestampRaw = event.timestamp;
  const timestampMs =
    typeof timestampRaw === "number"
      ? timestampRaw
      : typeof timestampRaw === "string"
        ? Number(timestampRaw)
        : NaN;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

  const model =
    typeof event.model === "string" && event.model.trim().length > 0
      ? event.model.trim()
      : "unknown";

  const uncachedInputTokens = int(tokenUsage.inputTokens);
  const cachedInputTokens = int(tokenUsage.cacheReadTokens);
  const cacheCreationTokens = int(tokenUsage.cacheWriteTokens);
  const outputTokens = int(tokenUsage.outputTokens);
  if (uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens === 0) {
    return null;
  }

  const chargedCents = positiveNumber(event.chargedCents);
  const totalCents = positiveNumber(tokenUsage.totalCents);
  // Prefer dashboard "included value" (totalCents) so Usage stays an API
  // estimate like Claude/Codex. Fall back to charged on-demand spend.
  const reportedCostUsd =
    totalCents !== null ? totalCents / 100 : chargedCents !== null ? chargedCents / 100 : null;

  const conversationId = typeof event.conversationId === "string" ? event.conversationId : "";
  const dedupeKey = `${Math.trunc(timestampMs)}:${conversationId}:${model}`;

  return {
    provider: "cursor",
    timestampMs: Math.trunc(timestampMs),
    model,
    sessionId: conversationId,
    totals: {
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens: 0,
    },
    reportedCostUsd,
    dedupeKey,
  };
}

async function fetchCursorUsageEventsPage(input: {
  readonly accessToken: string;
  readonly startDateMs: number;
  readonly endDateMs: number;
  readonly page: number;
  readonly pageSize: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<CursorFilteredUsageEventsResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CURSOR_USAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CURSOR_FILTERED_USAGE_EVENTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        startDate: String(Math.trunc(input.startDateMs)),
        endDate: String(Math.trunc(input.endDateMs)),
        page: input.page,
        pageSize: input.pageSize,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cursor usage API returned HTTP ${response.status}`);
    }
    return (await response.json()) as CursorFilteredUsageEventsResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loads Cursor usage events for `[startDateMs, endDateMs]` and converts them
 * into usage records. Missing sign-in is a soft `missing` source, not a hard
 * failure of the whole Usage page.
 */
export async function fetchCursorUsageRecords(input: {
  readonly startDateMs: number;
  readonly endDateMs: number;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly accessToken?: string | null;
  readonly stateDbPath?: string;
}): Promise<CursorUsageFetchResult> {
  const resolved =
    input.accessToken === undefined
      ? resolveCursorAccessToken({
          homeDirectory: input.homeDirectory,
          platform: input.platform,
          env: input.env,
          stateDbPath: input.stateDbPath,
        })
      : input.accessToken === null || input.accessToken.length === 0
        ? null
        : {
            token: normalizeAccessToken(input.accessToken),
            resolvedHomePath:
              input.stateDbPath ??
              resolveCursorStateDbPath(input.homeDirectory, input.platform, input.env),
          };

  if (resolved === null) {
    const stateDbPath =
      input.stateDbPath ?? resolveCursorStateDbPath(input.homeDirectory, input.platform, input.env);
    return {
      status: "missing",
      records: [],
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      message: "Sign in to the Cursor app on this machine to report Cursor usage.",
      resolvedHomePath: stateDbPath,
    };
  }

  const { token: accessToken, resolvedHomePath } = resolved;

  try {
    const records: UsageRecord[] = [];
    let malformedRecords = 0;
    let page = 1;
    let totalCount: number | null = null;

    while (page <= CURSOR_USAGE_MAX_PAGES) {
      const payload = await fetchCursorUsageEventsPage({
        accessToken,
        startDateMs: input.startDateMs,
        endDateMs: input.endDateMs,
        page,
        pageSize: CURSOR_USAGE_PAGE_SIZE,
        fetchImpl: input.fetchImpl,
      });

      if (typeof payload.totalUsageEventsCount === "number") {
        totalCount = payload.totalUsageEventsCount;
      }

      const events = Array.isArray(payload.usageEventsDisplay) ? payload.usageEventsDisplay : [];
      if (events.length === 0) break;

      for (const event of events) {
        if (typeof event !== "object" || event === null) {
          malformedRecords += 1;
          continue;
        }
        const parsed = parseCursorUsageEvent(event as CursorUsageEvent);
        if (parsed === null) {
          malformedRecords += 1;
          continue;
        }
        records.push(parsed);
      }

      if (events.length < CURSOR_USAGE_PAGE_SIZE) break;
      if (totalCount !== null && page * CURSOR_USAGE_PAGE_SIZE >= totalCount) break;
      page += 1;
    }

    return {
      status: "ok",
      records,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords,
      message: null,
      resolvedHomePath,
    };
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : "Cursor usage API request failed.";
    return {
      status: "failed",
      records: [],
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      message: detail.slice(0, 240),
      resolvedHomePath,
    };
  }
}

type CursorPlanUsage = {
  readonly totalSpend?: unknown;
  readonly includedSpend?: unknown;
  readonly limit?: unknown;
  readonly autoPercentUsed?: unknown;
  readonly apiPercentUsed?: unknown;
  readonly totalPercentUsed?: unknown;
};

function centsToUsdLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function msToIso(value: unknown): string | null {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Loads Cursor billing-cycle plan meters for the sidebar Usage popup.
 *
 * Uses the same local session token path as `cursor-usage` /
 * {@link fetchCursorUsageRecords}, then `GetCurrentPeriodUsage`.
 */
export async function fetchCursorPeriodQuota(input?: {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly accessToken?: string | null;
  readonly stateDbPath?: string;
}): Promise<UsageQuotaProvider> {
  const resolved =
    input?.accessToken === undefined
      ? resolveCursorAccessToken({
          homeDirectory: input?.homeDirectory,
          platform: input?.platform,
          env: input?.env,
          stateDbPath: input?.stateDbPath,
        })
      : input.accessToken === null || input.accessToken.length === 0
        ? null
        : {
            token: normalizeAccessToken(input.accessToken),
            resolvedHomePath:
              input.stateDbPath ??
              resolveCursorStateDbPath(input.homeDirectory, input.platform, input.env),
          };

  if (resolved === null) {
    return {
      provider: "cursor",
      status: "missing",
      label: "Cursor",
      planLabel: null,
      meters: [],
      message: "Sign in to the Cursor app to see plan limits.",
    };
  }

  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CURSOR_USAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CURSOR_CURRENT_PERIOD_USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cursor period usage returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      readonly billingCycleEnd?: unknown;
      readonly planUsage?: CursorPlanUsage | null;
      readonly displayMessage?: unknown;
    };

    const plan = payload.planUsage;
    const meters: UsageQuotaMeter[] = [];
    const resetsAt = msToIso(payload.billingCycleEnd);

    if (plan && typeof plan === "object") {
      const limitCents = positiveNumber(plan.limit);
      const includedSpend = positiveNumber(plan.includedSpend) ?? 0;
      const totalSpend = positiveNumber(plan.totalSpend) ?? includedSpend;

      if (limitCents !== null && limitCents > 0) {
        const usedPercent = clampPercent((includedSpend / limitCents) * 100);
        meters.push({
          id: "plan",
          label: "Included usage",
          usedPercent,
          remainingPercent: clampPercent(100 - usedPercent),
          detail: `${centsToUsdLabel(includedSpend)} of ${centsToUsdLabel(limitCents)} used`,
          resetsAt,
        });
      }

      const autoPercent =
        typeof plan.autoPercentUsed === "number" ? clampPercent(plan.autoPercentUsed) : null;
      if (autoPercent !== null) {
        meters.push({
          id: "auto",
          label: "Composer / Auto",
          usedPercent: autoPercent,
          remainingPercent: clampPercent(100 - autoPercent),
          detail: null,
          resetsAt,
        });
      }

      const apiPercent =
        typeof plan.apiPercentUsed === "number" ? clampPercent(plan.apiPercentUsed) : null;
      if (apiPercent !== null) {
        meters.push({
          id: "api",
          label: "Other models",
          usedPercent: apiPercent,
          remainingPercent: clampPercent(100 - apiPercent),
          detail: null,
          resetsAt,
        });
      }

      // Fallback when spend fields are missing but total % exists.
      if (meters.length === 0 && typeof plan.totalPercentUsed === "number") {
        const usedPercent = clampPercent(plan.totalPercentUsed);
        meters.push({
          id: "total",
          label: "Plan usage",
          usedPercent,
          remainingPercent: clampPercent(100 - usedPercent),
          detail: totalSpend > 0 ? `${centsToUsdLabel(totalSpend)} compute used` : null,
          resetsAt,
        });
      }
    }

    return {
      provider: "cursor",
      status: "ok",
      label: "Cursor",
      planLabel: null,
      meters,
      message:
        meters.length === 0
          ? typeof payload.displayMessage === "string"
            ? payload.displayMessage
            : "No Cursor plan meters available."
          : null,
    };
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : "Cursor plan usage request failed.";
    return {
      provider: "cursor",
      status: "failed",
      label: "Cursor",
      planLabel: null,
      meters: [],
      message: detail.slice(0, 240),
    };
  } finally {
    clearTimeout(timeout);
  }
}
