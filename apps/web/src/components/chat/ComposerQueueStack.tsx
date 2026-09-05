import type { MessageId } from "@t3tools/contracts";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CornerDownRightIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export interface ComposerQueueItem {
  readonly id: MessageId;
  readonly text: string;
  readonly pausedReason?: string | null;
  readonly imagePreviewSrc?: string | null;
}

interface ComposerQueueStackProps {
  readonly items: ReadonlyArray<ComposerQueueItem>;
  readonly canSteer: boolean;
  readonly onSteer: (messageId: MessageId) => void | Promise<void>;
  readonly onCancel: (messageId: MessageId) => void | Promise<void>;
  readonly onEdit: (messageId: MessageId, text: string) => void | Promise<void>;
  readonly isInterrupted?: boolean;
  readonly onResumeInterruptedQueue?: () => void | Promise<void>;
  readonly onRetry?: (messageId: MessageId) => void | Promise<void>;
  readonly onReorder?: (items: ReadonlyArray<ComposerQueueItem>) => void;
}

function QueueRow({
  item,
  canReorder,
  canSteer,
  onSteer,
  onCancel,
  onEdit,
  onRetry,
}: {
  item: ComposerQueueItem;
  canReorder: boolean;
} & Pick<ComposerQueueStackProps, "canSteer" | "onSteer" | "onCancel" | "onEdit" | "onRetry">) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortable = useSortable({ id: item.id, disabled: !canReorder || busy || draft !== null });
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this queued message.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      data-chat-composer-queue-item="true"
      data-message-id={item.id}
      className="rounded-lg px-3 py-1.5 text-sm hover:bg-muted/30"
    >
      <div className="flex min-h-6 items-center gap-2">
        {canReorder ? (
          <button
            type="button"
            ref={sortable.setActivatorNodeRef}
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label="Reorder queued message"
            className="cursor-grab touch-none text-muted-foreground"
          >
            <GripVerticalIcon className="size-3" />
          </button>
        ) : (
          <CornerDownRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        {item.imagePreviewSrc ? (
          <img
            src={item.imagePreviewSrc}
            alt="Image attachment"
            className="size-6 rounded object-cover"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate" title={item.text}>
          {item.text || "Attachment"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy || draft !== null || (item.pausedReason ? !onRetry : !canSteer)}
          aria-label={item.pausedReason ? "Retry" : "Steer"}
          title={
            item.pausedReason
              ? "Try sending this queued message again"
              : "Submit to the active turn"
          }
          onClick={() =>
            void run(() => (item.pausedReason && onRetry ? onRetry(item.id) : onSteer(item.id)))
          }
        >
          <CornerDownRightIcon className="size-3" />
          {item.pausedReason ? "Retry" : "Steer"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-micro"
          aria-label="Delete queued message"
          disabled={busy}
          onClick={() => void run(() => onCancel(item.id))}
        >
          <Trash2Icon className="size-3" />
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-micro"
                aria-label="Queued message actions"
                disabled={busy}
              />
            }
          >
            <MoreHorizontalIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() => {
                setDraft(item.text);
                setError(null);
              }}
            >
              <PencilIcon />
              Edit message
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {draft !== null ? (
        <div className="mt-2 space-y-2">
          <textarea
            aria-label="Edit queued message"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-20 w-full resize-y rounded-lg border border-border bg-background p-2 outline-none focus:border-ring"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={busy || !draft.trim()}
              onClick={() =>
                void run(async () => {
                  await onEdit(item.id, draft);
                  setDraft(null);
                })
              }
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
      {error || item.pausedReason ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error || item.pausedReason}
        </p>
      ) : null}
    </div>
  );
}

export function ComposerQueueStack({
  items,
  canSteer,
  onSteer,
  onCancel,
  onEdit,
  isInterrupted = false,
  onResumeInterruptedQueue,
  onRetry,
  onReorder,
}: ComposerQueueStackProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!items.length) return null;
  const reorder = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !onReorder) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from >= 0 && to >= 0) onReorder(arrayMove([...items], from, to));
  };
  return (
    <section
      aria-label="Queued messages"
      data-chat-composer-queue="true"
      className="mx-2 overflow-hidden rounded-t-xl border border-b-0 border-border/60 bg-muted/25"
    >
      <div className="flex min-h-8 items-center gap-2 border-b border-border/40 px-3 text-xs text-muted-foreground">
        <span className="flex-1">
          {isInterrupted
            ? "Queue paused because you interrupted"
            : items.some((item) => item.pausedReason)
              ? "Queue paused"
              : "Runs next"}
        </span>
        {isInterrupted ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!onResumeInterruptedQueue}
            onClick={() => void onResumeInterruptedQueue?.()}
          >
            <PlayIcon className="size-3" />
            Resume
          </Button>
        ) : (
          <span>{items.length} waiting</span>
        )}
      </div>
      <div className="max-h-[30dvh] overflow-y-auto">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                canReorder={items.length > 1 && !!onReorder}
                canSteer={canSteer}
                onSteer={onSteer}
                onCancel={onCancel}
                onEdit={onEdit}
                {...(onRetry ? { onRetry } : {})}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}
