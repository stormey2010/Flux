/**
 * Compact plan-limit state for the sidebar Usage popup.
 *
 * @module state/usageQuota
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { UsageQuotaSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { usePrimaryEnvironmentId } from "./environments";
import { serverEnvironment } from "./server";

const EMPTY_QUOTA_ATOM = Atom.make(AsyncResult.initial<UsageQuotaSummary>(true)).pipe(
  Atom.withLabel("usage-quota:empty"),
);

export function useUsageQuota(): {
  readonly summary: UsageQuotaSummary | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const environmentId = usePrimaryEnvironmentId();
  const quotaAtom =
    environmentId === null
      ? EMPTY_QUOTA_ATOM
      : serverEnvironment.usageQuota({ environmentId, input: {} });
  const result = useAtomValue(quotaAtom);
  const refreshAtom = useAtomRefresh(quotaAtom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);

  return useMemo(() => {
    if (environmentId === null) {
      return { summary: null, isPending: false, error: null, refresh };
    }
    return {
      summary: Option.getOrNull(AsyncResult.value(result)),
      isPending: result.waiting,
      error: result._tag === "Failure" ? "Could not load plan limits." : null,
      refresh,
    };
  }, [environmentId, refresh, result]);
}
