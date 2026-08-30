import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

import {
  providerQuotaLabel,
  providerQuotaNotice,
  shouldShowProviderQuota,
} from "../usage/ProviderQuotaLimits";

export type ComposerUsageMeterModel = {
  readonly providerLabel: string;
  readonly usageLimits: ServerProviderUsageLimits;
  readonly usedPercent: number;
};

export function headlineUsageUsedPercent(windows: ServerProviderUsageLimits["windows"]): number {
  if (windows.length === 0) return 0;
  return Math.max(...windows.map((window) => window.usedPercent));
}

/**
 * Chat-box usage is opt-in, scoped to the thread's current provider, and
 * hidden until the thread has started a turn. Unavailable, unpaid, or empty
 * snapshots stay hidden so the chat box never renders an error state next
 * to send.
 */
export function resolveComposerUsageMeter(input: {
  readonly enabled: boolean;
  readonly hasStartedTurn: boolean;
  readonly provider: ServerProvider | null | undefined;
}): ComposerUsageMeterModel | null {
  if (!input.enabled || !input.hasStartedTurn) return null;
  const provider = input.provider;
  if (!provider || !shouldShowProviderQuota(provider)) return null;
  if (providerQuotaNotice(provider) !== null) return null;

  const usageLimits = provider.usageLimits;
  if (!usageLimits?.available || usageLimits.windows.length === 0) return null;

  return {
    providerLabel: providerQuotaLabel(provider),
    usageLimits,
    usedPercent: headlineUsageUsedPercent(usageLimits.windows),
  };
}
