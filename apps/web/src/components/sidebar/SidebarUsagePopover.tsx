import type { UsageQuotaMeter, UsageQuotaProvider, UsageQuotaSummary } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { ChartNoAxesColumnIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useUsageQuota } from "../../state/usageQuota";
import { Button } from "../ui/button";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

export function formatReset(resetsAt: string | null, now = new Date()): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function compactMeterLabel(label: string): string {
  return label.replace(/^5-hour$/i, "5h").replace(/^24-hour$/i, "Daily");
}

function CompactMeterRow({ meter }: { readonly meter: UsageQuotaMeter }) {
  const remaining = meter.remainingPercent;
  const reset = formatReset(meter.resetsAt);
  const remainingClassName =
    remaining !== null && remaining <= 0
      ? "text-destructive"
      : remaining !== null && remaining < 10
        ? "text-amber-500"
        : "text-foreground";

  return (
    <div className="flex items-center justify-between gap-3 text-xs leading-5">
      <span className="min-w-0 truncate text-muted-foreground">
        {compactMeterLabel(meter.label)}
      </span>
      <span className="flex shrink-0 items-center gap-2 tabular-nums">
        <span className={cn("font-medium", remainingClassName)}>
          {remaining !== null
            ? `${remaining.toFixed(remaining >= 10 ? 0 : 1)}%`
            : (meter.detail ?? "—")}
        </span>
        {reset ? <span className="text-muted-foreground">{reset}</span> : null}
      </span>
    </div>
  );
}

function ProviderQuotaBlock({ provider }: { readonly provider: UsageQuotaProvider }) {
  const presentation = PROVIDER_PRESENTATION[provider.provider];
  const Mark = presentation.mark;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Mark className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {provider.label}
        </span>
        {provider.planLabel ? (
          <span className="truncate text-[10px] text-muted-foreground/70">
            {provider.planLabel}
          </span>
        ) : null}
      </div>
      {provider.status !== "ok" || provider.meters.length === 0 ? (
        <p className="py-0.5 text-xs text-muted-foreground">
          {provider.message ??
            (provider.status === "missing"
              ? "Not signed in on this machine."
              : "Limits unavailable.")}
        </p>
      ) : (
        <div className="space-y-0.5">
          {provider.meters.map((meter) => (
            <CompactMeterRow key={meter.id} meter={meter} />
          ))}
        </div>
      )}
    </div>
  );
}

export const SidebarUsagePopoverContent = memo(function SidebarUsagePopoverContent({
  onOpenFull,
}: {
  readonly onOpenFull: () => void;
}) {
  const { summary, isPending, error, refresh } = useUsageQuota();
  const providers = useMemo(() => summary?.providers ?? [], [summary]);

  return (
    <div className="w-[16rem] max-w-[calc(100vw-2rem)]">
      <div className="-mx-3 -mt-3 flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ChartNoAxesColumnIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold text-foreground">Usage remaining</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Reload usage"
            className="size-7"
            disabled={isPending}
            onClick={refresh}
            size="icon"
            title="Reload usage"
            variant="ghost"
          >
            <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
          </Button>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </div>
      </div>

      <div className="divide-y divide-border/50 py-1">
        {error ? <p className="py-2 text-xs text-destructive">{error}</p> : null}

        {providers.length === 0 && !isPending ? (
          <p className="py-2 text-xs text-muted-foreground">No provider limits reported yet.</p>
        ) : (
          providers.map((provider) => (
            <div key={provider.provider} className="py-2 first:pt-1 last:pb-1">
              <ProviderQuotaBlock provider={provider} />
            </div>
          ))
        )}
      </div>

      <div className="-mx-3 -mb-3 border-t border-border/60 px-3 py-2">
        <Button className="h-7 w-full text-xs" size="sm" variant="ghost" onClick={onOpenFull}>
          Full usage
        </Button>
      </div>
    </div>
  );
});

// Keep the type import used for documentation / future tests.
export type { UsageQuotaSummary };
