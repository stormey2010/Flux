import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { ProviderUsageBars } from "../usage/ProviderQuotaLimits";
import type { ComposerUsageMeterModel } from "./ComposerUsageMeter.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number): string {
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function usageMeterTextClass(percent: number): string {
  if (percent >= 90) return "text-destructive";
  if (percent >= 70) return "text-warning";
  return "text-muted-foreground";
}

export function ComposerProviderUsageDetails(props: { usage: ComposerUsageMeterModel }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Usage</div>
        <div className="truncate text-secondary-label text-[11px]">{props.usage.providerLabel}</div>
      </div>
      <ProviderUsageBars usageLimits={props.usage.usageLimits} className="gap-2" />
    </div>
  );
}

export function ComposerUsageMeter(props: { usage: ComposerUsageMeterModel }) {
  const { usage } = props;
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercent));
  const usedPercentage = formatPercentage(normalizedPercentage);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="sm"
            variant="ghost-muted"
            className="h-7 rounded-full px-2 hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={`${usage.providerLabel} usage ${usedPercentage} used`}
          >
            <span
              className={cn(
                "text-[11px] tabular-nums font-medium",
                usageMeterTextClass(normalizedPercentage),
              )}
            >
              {usedPercentage}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <ComposerProviderUsageDetails usage={usage} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
