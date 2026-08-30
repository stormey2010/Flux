import {
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type AgentProfile,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function selectionKey(selection: ModelSelection): string {
  return `${selection.instanceId}::${selection.model}`;
}

function modelSelectionFromKey(value: string): ModelSelection | null {
  const separator = value.indexOf("::");
  if (separator <= 0) return null;
  const instanceId = value.slice(0, separator);
  const model = value.slice(separator + 2);
  return model.length > 0 ? { instanceId: ProviderInstanceId.make(instanceId), model } : null;
}

type ReasoningDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

const REASONING_OPTION_IDS = new Set(["reasoningEffort", "effort", "reasoning", "variant"]);

function reasoningDescriptorFor(
  selection: ModelSelection | null,
  descriptorsByModel: ReadonlyMap<string, ReasoningDescriptor>,
): ReasoningDescriptor | null {
  return selection ? (descriptorsByModel.get(selectionKey(selection)) ?? null) : null;
}

function selectedReasoningValue(
  selection: ModelSelection,
  descriptor: ReasoningDescriptor,
): string {
  const selected = selection.options?.find((option) => option.id === descriptor.id);
  if (
    typeof selected?.value === "string" &&
    descriptor.options.some((option) => option.id === selected.value)
  ) {
    return selected.value;
  }
  return (
    descriptor.currentValue ??
    descriptor.options.find((option) => option.isDefault)?.id ??
    descriptor.options[0]?.id ??
    ""
  );
}

function withReasoningValue(
  selection: ModelSelection,
  descriptor: ReasoningDescriptor,
  value: string,
): ModelSelection {
  const options = (selection.options ?? []).filter((option) => option.id !== descriptor.id);
  const nextOptions: ProviderOptionSelection[] = [...options, { id: descriptor.id, value }];
  return { ...selection, options: nextOptions };
}

function AgentModelSelect({
  value,
  options,
  onChange,
  ariaLabel,
  inheritLabel = "Use coordinator model",
}: {
  value: ModelSelection | null;
  options: ReadonlyArray<ModelSelection>;
  onChange: (selection: ModelSelection | null) => void;
  ariaLabel: string;
  inheritLabel?: string;
}) {
  const selectedValue = value ? selectionKey(value) : "inherit";
  return (
    <Select
      value={selectedValue}
      onValueChange={(next) => {
        if (next === null || next === "inherit") {
          onChange(null);
          return;
        }
        onChange(modelSelectionFromKey(next));
      }}
    >
      <SelectTrigger className="w-full sm:w-64" aria-label={ariaLabel}>
        <SelectValue>{value ? `${value.instanceId} · ${value.model}` : inheritLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          {inheritLabel}
        </SelectItem>
        {options.map((option) => (
          <SelectItem hideIndicator key={selectionKey(option)} value={selectionKey(option)}>
            {option.instanceId} · {option.model}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ReasoningSelect({
  value,
  descriptor,
  onChange,
  ariaLabel,
}: {
  value: ModelSelection;
  descriptor: ReasoningDescriptor | null;
  onChange: (selection: ModelSelection) => void;
  ariaLabel: string;
}) {
  if (!descriptor || descriptor.options.length === 0) return null;
  const selected = selectedReasoningValue(value, descriptor);
  return (
    <Select
      value={selected}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0) {
          onChange(withReasoningValue(value, descriptor, next));
        }
      }}
    >
      <SelectTrigger className="w-full sm:w-48" aria-label={ariaLabel}>
        <SelectValue>
          {descriptor.label}:{" "}
          {descriptor.options.find((option) => option.id === selected)?.label ?? selected}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {descriptor.options.map((option) => (
          <SelectItem hideIndicator key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function newProfile(index: number): AgentProfile {
  return {
    id: `custom-agent-${Date.now()}-${index}`,
    name: `Custom agent ${index}`,
    description: "A custom delegation role.",
    instructions:
      "Describe what this agent should own, how it should work, and what it should return.",
    enabled: true,
    primaryModel: null,
    backupModels: [],
    maxParallel: 1,
    timeoutSeconds: 900,
    allowNested: false,
  };
}

function ProfileCard({
  profile,
  modelOptions,
  reasoningDescriptorsByModel,
  onChange,
  onDelete,
}: {
  profile: AgentProfile;
  modelOptions: ReadonlyArray<ModelSelection>;
  reasoningDescriptorsByModel: ReadonlyMap<string, ReasoningDescriptor>;
  onChange: (patch: Partial<AgentProfile>) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(profile.id.startsWith("custom-agent"));
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [instructions, setInstructions] = useState(profile.instructions);
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => setDescription(profile.description), [profile.description]);
  useEffect(() => setInstructions(profile.instructions), [profile.instructions]);
  const addBackup = (selection: ModelSelection | null) => {
    if (
      !selection ||
      profile.backupModels.some((item) => selectionKey(item) === selectionKey(selection))
    ) {
      return;
    }
    onChange({ backupModels: [...profile.backupModels, selection] });
  };
  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onBlur={() => onChange({ name: name.trim() || "Untitled agent" })}
            aria-label={`${profile.name} name`}
            className="h-7 border-0 bg-transparent px-1 text-sm font-semibold shadow-none focus-visible:ring-1"
          />
          <p className="truncate px-1 text-xs text-muted-foreground">
            {profile.description || "No description"}
          </p>
        </div>
        <Switch
          checked={profile.enabled}
          onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
          aria-label={`Enable ${profile.name}`}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${profile.name}`}
        >
          {expanded ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${profile.name}`}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-border/50 pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Description
              <Input
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                onBlur={() => onChange({ description: description.trim() })}
                aria-label={`${profile.name} description`}
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Primary model
              <div className="space-y-2">
                <AgentModelSelect
                  value={profile.primaryModel}
                  options={modelOptions}
                  onChange={(primaryModel) => onChange({ primaryModel })}
                  ariaLabel={`${profile.name} primary model`}
                />
                {profile.primaryModel ? (
                  <ReasoningSelect
                    value={profile.primaryModel}
                    descriptor={reasoningDescriptorFor(
                      profile.primaryModel,
                      reasoningDescriptorsByModel,
                    )}
                    onChange={(primaryModel) => onChange({ primaryModel })}
                    ariaLabel={`${profile.name} reasoning level`}
                  />
                ) : null}
              </div>
            </label>
          </div>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Instructions
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              onBlur={() => onChange({ instructions: instructions.trim() })}
              className="min-h-28"
              aria-label={`${profile.name} instructions`}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs text-muted-foreground">
              Max parallel
              <Input
                type="number"
                min={1}
                max={8}
                value={profile.maxParallel}
                onChange={(event) =>
                  onChange({
                    maxParallel: Math.min(8, Math.max(1, Number(event.currentTarget.value) || 1)),
                  })
                }
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Timeout (seconds)
              <Input
                type="number"
                min={30}
                max={3600}
                value={profile.timeoutSeconds}
                onChange={(event) =>
                  onChange({
                    timeoutSeconds: Math.min(
                      3600,
                      Math.max(30, Number(event.currentTarget.value) || 30),
                    ),
                  })
                }
              />
            </label>
            <label className="flex items-end gap-2 pb-1 text-xs text-muted-foreground">
              <Switch
                checked={profile.allowNested}
                onCheckedChange={(checked) => onChange({ allowNested: Boolean(checked) })}
                aria-label={`Allow nested agents for ${profile.name}`}
              />
              Allow nested agents
            </label>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground">Backup models</div>
            <div className="flex flex-wrap gap-2">
              {profile.backupModels.map((backup) => (
                <div
                  key={selectionKey(backup)}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/40 p-1.5"
                >
                  <span className="px-1 text-xs text-foreground/80">
                    {backup.instanceId} · {backup.model}
                  </span>
                  <ReasoningSelect
                    value={backup}
                    descriptor={reasoningDescriptorFor(backup, reasoningDescriptorsByModel)}
                    onChange={(next) =>
                      onChange({
                        backupModels: profile.backupModels.map((item) =>
                          selectionKey(item) === selectionKey(backup) ? next : item,
                        ),
                      })
                    }
                    ariaLabel={`${profile.name} backup reasoning level`}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        backupModels: profile.backupModels.filter(
                          (item) => selectionKey(item) !== selectionKey(backup),
                        ),
                      })
                    }
                    aria-label={`Remove ${backup.model} backup`}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </div>
              ))}
              {profile.backupModels.length < 5 ? (
                <AgentModelSelect
                  value={null}
                  options={modelOptions.filter(
                    (option) =>
                      !profile.backupModels.some(
                        (item) => selectionKey(item) === selectionKey(option),
                      ),
                  )}
                  onChange={addBackup}
                  ariaLabel={`Add backup model for ${profile.name}`}
                  inheritLabel="Add backup model"
                />
              ) : null}
            </div>
            {profile.backupModels.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                If the primary model is unavailable, the coordinator will fall back to its own
                model.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [delegationInstructions, setDelegationInstructions] = useState(
    settings.delegationInstructions,
  );
  useEffect(
    () => setDelegationInstructions(settings.delegationInstructions),
    [settings.delegationInstructions],
  );
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const modelOptions = useMemo(() => {
    const options: ModelSelection[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const model of entry.models) {
        const selection = {
          instanceId: entry.instanceId,
          model: model.slug,
        } satisfies ModelSelection;
        const key = selectionKey(selection);
        if (!seen.has(key)) {
          seen.add(key);
          options.push(selection);
        }
      }
    }
    return options;
  }, [entries]);
  const reasoningDescriptorsByModel = useMemo(() => {
    const descriptors = new Map<string, ReasoningDescriptor>();
    for (const entry of entries) {
      for (const model of entry.models) {
        const descriptor = model.capabilities?.optionDescriptors?.find(
          (candidate): candidate is ReasoningDescriptor =>
            candidate.type === "select" && REASONING_OPTION_IDS.has(candidate.id),
        );
        if (descriptor) {
          descriptors.set(
            selectionKey({ instanceId: entry.instanceId, model: model.slug }),
            descriptor,
          );
        }
      }
    }
    return descriptors;
  }, [entries]);
  const profiles = settings.agentProfiles;
  const addCoordinatorBackup = (selection: ModelSelection | null) => {
    if (
      !selection ||
      settings.coordinatorBackupModels.some(
        (item) => selectionKey(item) === selectionKey(selection),
      )
    ) {
      return;
    }
    updateSettings({ coordinatorBackupModels: [...settings.coordinatorBackupModels, selection] });
  };
  const updateProfile = (id: string, patch: Partial<AgentProfile>) => {
    updateSettings({
      agentProfiles: profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    });
  };
  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title="Agents & Workflows"
        icon={<WorkflowIcon className="size-4 text-muted-foreground" />}
        className="space-y-4"
      >
        <SettingsRow
          title="Enable delegation"
          description="Let the coordinator use your configured roles when a request benefits from parallel work."
          control={
            <Switch
              checked={settings.delegationEnabled}
              onCheckedChange={(checked) => updateSettings({ delegationEnabled: Boolean(checked) })}
              aria-label="Enable agent delegation"
            />
          }
        />
        <SettingsRow
          title="Coordinator instructions"
          description="Global guidance applied when the main agent decides how to delegate work."
          control={
            <Textarea
              value={delegationInstructions}
              onChange={(event) => setDelegationInstructions(event.currentTarget.value)}
              onBlur={() =>
                updateSettings({ delegationInstructions: delegationInstructions.trim() })
              }
              className="w-full sm:w-96"
              aria-label="Coordinator instructions"
            />
          }
        />
        <SettingsRow
          title="Coordinator model"
          description="The model used by Default agent in the main chat picker. Leave it inherited to use the model selected for the chat."
          control={
            <div className="space-y-2">
              <AgentModelSelect
                value={settings.coordinatorModel}
                options={modelOptions}
                onChange={(coordinatorModel) => updateSettings({ coordinatorModel })}
                ariaLabel="Coordinator model"
                inheritLabel="Use chat model"
              />
              {settings.coordinatorModel ? (
                <ReasoningSelect
                  value={settings.coordinatorModel}
                  descriptor={reasoningDescriptorFor(
                    settings.coordinatorModel,
                    reasoningDescriptorsByModel,
                  )}
                  onChange={(coordinatorModel) => updateSettings({ coordinatorModel })}
                  ariaLabel="Coordinator reasoning level"
                />
              ) : null}
            </div>
          }
        />
        <SettingsRow
          title="Coordinator backup models"
          description="Ordered live-provider fallbacks if the coordinator model is unavailable or rate-limited."
          control={
            <div className="flex w-full max-w-xl flex-wrap justify-end gap-2">
              {settings.coordinatorBackupModels.map((backup) => (
                <div
                  key={selectionKey(backup)}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/40 p-1.5"
                >
                  <span className="px-1 text-xs text-foreground/80">
                    {backup.instanceId} · {backup.model}
                  </span>
                  <ReasoningSelect
                    value={backup}
                    descriptor={reasoningDescriptorFor(backup, reasoningDescriptorsByModel)}
                    onChange={(next) =>
                      updateSettings({
                        coordinatorBackupModels: settings.coordinatorBackupModels.map((item) =>
                          selectionKey(item) === selectionKey(backup) ? next : item,
                        ),
                      })
                    }
                    ariaLabel="Coordinator backup reasoning level"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      updateSettings({
                        coordinatorBackupModels: settings.coordinatorBackupModels.filter(
                          (item) => selectionKey(item) !== selectionKey(backup),
                        ),
                      })
                    }
                    aria-label={`Remove ${backup.model} coordinator backup`}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </div>
              ))}
              {settings.coordinatorBackupModels.length < 5 ? (
                <AgentModelSelect
                  value={null}
                  options={modelOptions.filter(
                    (option) =>
                      !settings.coordinatorBackupModels.some(
                        (item) => selectionKey(item) === selectionKey(option),
                      ),
                  )}
                  onChange={addCoordinatorBackup}
                  ariaLabel="Add coordinator backup model"
                  inheritLabel="Add backup model"
                />
              ) : null}
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Agent profiles"
        icon={<BotIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              updateSettings({ agentProfiles: [...profiles, newProfile(profiles.length + 1)] })
            }
          >
            <PlusIcon className="size-3.5" /> Add agent
          </Button>
        }
      >
        <p className="mx-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm text-muted-foreground sm:mx-4">
          Profiles are named roles the coordinator can delegate to. Every model option comes from a
          currently reported provider model; no preset catalog is added. Reasoning appears only when
          that model reports support for it.
        </p>
        <div className="space-y-3 px-3 sm:px-4">
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              modelOptions={modelOptions}
              reasoningDescriptorsByModel={reasoningDescriptorsByModel}
              onChange={(patch) => updateProfile(profile.id, patch)}
              onDelete={() =>
                updateSettings({ agentProfiles: profiles.filter((item) => item.id !== profile.id) })
              }
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
