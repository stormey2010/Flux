import type { MessageId } from "@t3tools/contracts";
import { autoAnimate } from "@formkit/auto-animate";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDownIcon,
  CornerDownRightIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerQueueItem {
  readonly id: MessageId;
  readonly text: string;
  readonly pausedReason?: string | null;
  readonly imagePreviewSrc?: string | null;
}

interface ComposerQueueStackProps {
  readonly items: ReadonlyArray<ComposerQueueItem>;
  readonly canSteer: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onCancel: (messageId: MessageId) => void;
  /** Legacy callback retained for existing callers; editing remains parent-owned. */
  readonly onEdit: (messageId: MessageId, text: string) => void | Promise<void>;
  readonly isInterrupted?: boolean;
  readonly onResumeInterruptedQueue?: () => void;
  readonly editingMessageId?: MessageId | null;
  readonly onEditMessage?: (messageId: MessageId) => void;
  readonly isMessagePaused?: (pausedReason: string | null | undefined) => boolean;
  readonly onRetry?: (messageId: MessageId) => void;
  readonly isSendNowDisabled?: boolean;
  readonly onOpenInSideChat?: (messageId: MessageId) => void;
  readonly isQueueingEnabled?: boolean;
  readonly onQueueingChange?: (enabled: boolean) => void;
  readonly onReorder?: (items: ReadonlyArray<ComposerQueueItem>) => void;
}

function moveItem<T>(items: ReadonlyArray<T>, from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

function QueueRow({
  item,
  canReorder,
  isSendNowDisabled,
  isEditing,
  isPaused,
  onSteer,
  onRetry,
  onCancel,
  onEdit,
  onEditMessage,
  onOpenInSideChat,
  isQueueingEnabled,
  onQueueingChange,
}: {
  readonly item: ComposerQueueItem;
  readonly canReorder: boolean;
  readonly isSendNowDisabled: boolean;
  readonly isEditing: boolean;
  readonly isPaused: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onRetry: ((messageId: MessageId) => void) | undefined;
  readonly onCancel: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId, text: string) => void | Promise<void>;
  readonly onEditMessage: ((messageId: MessageId) => void) | undefined;
  readonly onOpenInSideChat: ((messageId: MessageId) => void) | undefined;
  readonly isQueueingEnabled: boolean | undefined;
  readonly onQueueingChange: ((enabled: boolean) => void) | undefined;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !canReorder });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const primaryLabel = isPaused ? "Retry" : "Steer";
  const primaryTooltipContent = isPaused ? (
    <div className="space-y-1 text-center">
      <p>Try sending this queued message again</p>
      <p className="opacity-65">Edit or delete it if retry keeps failing</p>
    </div>
  ) : (
    "Submit without interrupting the model"
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-chat-composer-queue-item="true"
      data-message-id={item.id}
      className={cn(
        "group overflow-visible rounded-lg transition-colors hover:bg-muted/35",
        (isEditing || isDragging) && "opacity-60",
        isDragging && "bg-muted/45 shadow-sm",
      )}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1.5 px-3 py-1.5">
        {canReorder ? (
          <span
            ref={setActivatorNodeRef}
            className="relative -ms-2.5 flex h-6 w-4 cursor-grab items-center justify-center rounded-sm ps-1 active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon
              className={cn(
                "pointer-events-none size-3 text-muted-foreground transition-opacity",
                isDragging ? "opacity-100" : "opacity-45 group-hover:opacity-100",
              )}
              aria-hidden="true"
            />
            <span className="sr-only">Drag to reorder</span>
          </span>
        ) : (
          <CornerDownRightIcon
            className="size-3 shrink-0 text-muted-foreground/70"
            aria-hidden="true"
          />
        )}

        {isPaused ? (
          <Tooltip>
            <TooltipTrigger render={<span className="mt-0.5 inline-flex shrink-0 text-warning" />}>
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup
              side="top"
              className="max-w-80 whitespace-normal text-center leading-snug"
            >
              <div className="space-y-1 text-center">
                <p>This queued message could not be sent</p>
                <p className="opacity-65">Retry, edit, or delete it to continue the queue</p>
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {item.imagePreviewSrc ? (
          <img
            className="size-6 shrink-0 rounded border border-border object-cover"
            src={item.imagePreviewSrc}
            alt="Image attachment"
            draggable={false}
          />
        ) : null}

        <div className="min-w-0 flex-1 self-center truncate leading-5 text-secondary-label">
          {item.text}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={isSendNowDisabled}
                  aria-label={primaryLabel}
                  data-markdown-copy="exclude"
                  className="h-6 gap-1 px-1.5 text-xs text-secondary-label hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (isPaused) {
                      (onRetry ?? onSteer)(item.id);
                    } else {
                      onSteer(item.id);
                    }
                  }}
                />
              }
            >
              {isPaused ? (
                <RotateCcwIcon className="size-3" aria-hidden="true" />
              ) : (
                <CornerDownRightIcon className="size-3" aria-hidden="true" />
              )}
              {primaryLabel}
            </TooltipTrigger>
            <TooltipPopup
              side="top"
              className="max-w-80 whitespace-normal text-center leading-snug"
            >
              {primaryTooltipContent}
            </TooltipPopup>
          </Tooltip>

          <Button
            type="button"
            variant="ghost"
            size="icon-micro"
            aria-label="Delete queued message"
            onClick={(event) => {
              event.stopPropagation();
              onCancel(item.id);
            }}
          >
            <Trash2Icon className="size-3" aria-hidden="true" />
          </Button>

          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-micro"
                        aria-label="Queued message actions"
                        onClick={(event) => event.stopPropagation()}
                      />
                    }
                  />
                }
              >
                <MoreHorizontalIcon className="size-3" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="top">Queued message actions</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  if (onEditMessage) onEditMessage(item.id);
                  else void onEdit(item.id, item.text);
                }}
              >
                <PencilIcon />
                Edit message
              </MenuItem>
              {onOpenInSideChat ? (
                <MenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenInSideChat(item.id);
                  }}
                >
                  <PanelRightIcon />
                  Open in side chat
                </MenuItem>
              ) : null}
              {onQueueingChange && typeof isQueueingEnabled === "boolean" ? (
                <MenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    onQueueingChange(!isQueueingEnabled);
                  }}
                >
                  <CornerDownRightIcon />
                  {isQueueingEnabled ? "Turn off queueing" : "Turn on queueing"}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
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
  editingMessageId = null,
  onEditMessage,
  isMessagePaused,
  onRetry,
  isSendNowDisabled = !canSteer,
  onOpenInSideChat,
  isQueueingEnabled,
  onQueueingChange,
  onReorder,
}: ComposerQueueStackProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);

  useEffect(() => {
    if (listRef.current) {
      autoAnimate(listRef.current, { duration: 180, easing: "ease-out" });
    }
  }, [isCollapsed]);

  if (items.length === 0) return null;

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !onReorder) return;
    const from = itemIds.indexOf(active.id as MessageId);
    const to = itemIds.indexOf(over.id as MessageId);
    if (from < 0 || to < 0) return;
    onReorder(moveItem(items, from, to));
  };

  return (
    <div
      data-chat-composer-queue="true"
      data-chat-composer-queue-collapsed={isCollapsed ? "true" : "false"}
      className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-background/90 shadow-sm backdrop-blur-md"
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-border/55 px-3 py-1">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? "Expand queue" : "Collapse queue"}
          data-testid="composer-queue-toggle"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-medium text-secondary-label outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
        >
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              !isCollapsed && "rotate-180",
            )}
            aria-hidden="true"
          />
          <span>Queue</span>
          <span className="truncate font-normal text-muted-foreground">
            · {items.length} message{items.length === 1 ? "" : "s"} waiting
          </span>
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {isInterrupted ? "Paused" : "Runs next"}
        </span>
      </div>

      {!isCollapsed ? (
        <div className="vertical-scroll-fade-mask hide-scrollbar flex max-h-[30dvh] flex-col gap-px overflow-x-hidden overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_8px,black_calc(100%-8px),transparent)] [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_8px,black_calc(100%-8px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {isInterrupted ? (
            <>
              <div className="flex min-h-8 items-center gap-2 px-3 py-1.5 text-xs text-secondary-label">
                <PlayIcon className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <span className="min-w-0 flex-1">Queue paused because you interrupted</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 gap-1 px-1.5 text-xs text-secondary-label hover:text-foreground"
                  disabled={!onResumeInterruptedQueue}
                  onClick={onResumeInterruptedQueue}
                >
                  <PlayIcon className="size-3" aria-hidden="true" />
                  Resume
                </Button>
              </div>
              <div className="border-t border-border/55" aria-hidden="true" />
            </>
          ) : null}

          <div ref={listRef} className="flex flex-col gap-px p-0.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                {items.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    canReorder={items.length > 1 && onReorder !== undefined}
                    isSendNowDisabled={isSendNowDisabled}
                    isEditing={editingMessageId === item.id}
                    isPaused={
                      isMessagePaused
                        ? isMessagePaused(item.pausedReason)
                        : Boolean(item.pausedReason)
                    }
                    onSteer={onSteer}
                    onRetry={onRetry}
                    onCancel={onCancel}
                    onEdit={onEdit}
                    onEditMessage={onEditMessage}
                    onOpenInSideChat={onOpenInSideChat}
                    isQueueingEnabled={isQueueingEnabled}
                    onQueueingChange={onQueueingChange}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </div>
      ) : null}
    </div>
  );
}
