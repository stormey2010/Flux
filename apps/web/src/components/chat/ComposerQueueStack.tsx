import type { MessageId } from "@t3tools/contracts";
import { ArrowDownIcon, CheckIcon, PencilIcon, Trash2Icon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface ComposerQueueItem {
  readonly id: MessageId;
  readonly text: string;
}

interface ComposerQueueStackProps {
  readonly items: ReadonlyArray<ComposerQueueItem>;
  readonly canSteer: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onCancel: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId, text: string) => void | Promise<void>;
}

function ComposerQueueRow({
  item,
  index,
  canSteer,
  onSteer,
  onCancel,
  onEdit,
}: {
  readonly item: ComposerQueueItem;
  readonly index: number;
  readonly canSteer: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onCancel: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId, text: string) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [isSaving, setIsSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) setDraft(item.text);
  }, [isEditing, item.text]);

  const save = async () => {
    if (draft.trim().length === 0) {
      setValidationError("Message cannot be empty");
      return;
    }
    setValidationError(null);
    setIsSaving(true);
    try {
      await onEdit(item.id, draft);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      data-chat-composer-queue-item="true"
      className={cn("min-w-0 px-3 py-2.5 sm:px-4", index > 0 && "border-t border-border/45")}
    >
      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            size="sm"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (validationError) setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(item.text);
                setValidationError(null);
                setIsEditing(false);
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
            aria-label={`Edit queued message ${index + 1}`}
            disabled={isSaving}
          />
          {validationError ? (
            <p className="text-xs text-destructive" role="alert">
              {validationError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={isSaving}
              onClick={() => {
                setDraft(item.text);
                setValidationError(null);
                setIsEditing(false);
              }}
            >
              <XIcon className="size-3" aria-hidden="true" />
              Cancel
            </Button>
            <Button type="button" size="xs" disabled={isSaving} onClick={() => void save()}>
              <CheckIcon className="size-3" aria-hidden="true" />
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>{index === 0 ? "Next" : `#${index + 1}`}</span>
            </div>
            <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90">
              {item.text.trim() || "Empty message"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                setDraft(item.text);
                setValidationError(null);
                setIsEditing(true);
              }}
              aria-label={`Edit queued message ${index + 1}`}
            >
              <PencilIcon className="size-3.5" aria-hidden="true" />
            </Button>
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
      )}
    </div>
  );
}

/**
 * Keeps queued turns attached to the composer so they remain actionable while
 * the timeline continues to stream. The first row runs next; the remaining
 * rows stay visible as a compact stack instead of being hidden in the history.
 */
export function ComposerQueueStack({
  items,
  canSteer,
  onSteer,
  onCancel,
  onEdit,
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
          <ComposerQueueRow
            key={item.id}
            item={item}
            index={index}
            canSteer={canSteer}
            onSteer={onSteer}
            onCancel={onCancel}
            onEdit={onEdit}
          />
        ))}
      </div>
    </section>
  );
}
