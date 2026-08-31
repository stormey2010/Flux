import type { MessageId } from "@t3tools/contracts";
import { ArrowDownIcon, Trash2Icon, ZapIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueueItem {
  readonly id: MessageId;
  readonly text: string;
}

interface ComposerQueueStackProps {
  readonly items: ReadonlyArray<ComposerQueueItem>;
  readonly canSteer: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onCancel: (messageId: MessageId) => void;
}

/**
 * Keeps queued turns attached to the composer so they remain actionable while
 * the timeline continues to stream. The first row is the next FIFO item; the
 * remaining rows stay visible as a compact stack instead of being hidden in
 * the message history.
 */
export function ComposerQueueStack({
  items,
  canSteer,
  onSteer,
  onCancel,
}: ComposerQueueStackProps) {
  if (items.length === 0) return null;

  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-chat-composer-queue="true"
      className="mb-2 overflow-hidden rounded-[18px] border border-border/70 bg-background/90 shadow-[0_8px_28px_rgba(0,0,0,0.14)] backdrop-blur-md"
    >
      <div className="flex items-center gap-2 border-b border-border/55 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <ArrowDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground/80">Queue</span>
        <span aria-hidden="true">·</span>
        <span>{items.length === 1 ? "1 message waiting" : `${items.length} messages waiting`}</span>
        <span className="ms-auto rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] tabular-nums">
          Runs next
        </span>
      </div>

      <div className="max-h-52 overflow-y-auto">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-chat-composer-queue-item="true"
            className={cn(
              "flex min-w-0 items-center gap-2 px-3 py-2.5 sm:px-4",
              index > 0 && "border-t border-border/45",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{index === 0 ? "Next" : `#${index + 1}`}</span>
                {index === 0 ? <span className="text-muted-foreground/60">· FIFO</span> : null}
              </div>
              <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90">
                {item.text.trim() || "Empty message"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={!canSteer}
                onClick={() => onSteer(item.id)}
                aria-label={`Steer queued message ${index + 1} now`}
                className="gap-1 px-2 text-xs"
              >
                <ZapIcon className="size-3" aria-hidden="true" />
                <span className="hidden sm:inline">Steer</span>
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                onClick={() => onCancel(item.id)}
                aria-label={`Cancel queued message ${index + 1}`}
              >
                <Trash2Icon className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
