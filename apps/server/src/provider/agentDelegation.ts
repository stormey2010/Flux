import type { AgentProfile, ModelSelection, ServerSettings } from "@t3tools/contracts";

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function modelLabel(profile: AgentProfile): string {
  if (!profile.primaryModel) return "inherit the coordinator model";
  const primary = `${profile.primaryModel.instanceId}:${profile.primaryModel.model}`;
  if (profile.backupModels.length === 0) return primary;
  return `${primary}; backups: ${profile.backupModels.map((model) => `${model.instanceId}:${model.model}`).join(", ")}`;
}

function selectionLabel(selection: ModelSelection | null): string {
  return selection
    ? `${selection.instanceId}:${selection.model}`
    : "inherit the model selected for this chat";
}

/** Render the user-configured role catalog as provider-neutral coordinator guidance. */
export function buildAgentDelegationInstructions(
  settings: Pick<ServerSettings, "agentProfiles" | "delegationEnabled" | "delegationInstructions"> &
    Partial<Pick<ServerSettings, "coordinatorModel" | "coordinatorBackupModels">>,
): string {
  if (!settings.delegationEnabled) return "";
  const profiles = settings.agentProfiles.filter((profile) => profile.enabled);
  if (profiles.length === 0) return "";
  const lines = [
    "<agent_delegation>",
    "The user configured the following delegation roles. Use them when parallel or specialized work improves the result.",
    `Coordinator policy: ${singleLine(settings.delegationInstructions)}`,
    `Coordinator model: ${selectionLabel(settings.coordinatorModel ?? null)}${(settings.coordinatorBackupModels ?? []).length > 0 ? `; backups: ${(settings.coordinatorBackupModels ?? []).map((model) => `${model.instanceId}:${model.model}`).join(", ")}` : ""}`,
    "Choose a role by id, give it one focused outcome, and avoid assigning overlapping edits. Prefer the configured primary model; try a listed backup when it is unavailable or rate-limited.",
  ];
  for (const profile of profiles) {
    lines.push(
      `- ${profile.id} (${profile.name}): ${singleLine(profile.description)} | model: ${modelLabel(profile)} | max parallel: ${profile.maxParallel} | timeout: ${profile.timeoutSeconds}s | nested: ${profile.allowNested ? "yes" : "no"}`,
      `  Instructions: ${singleLine(profile.instructions)}`,
    );
  }
  lines.push(
    "Do not claim a role ran unless the provider reports that subagent or workflow activity actually started.",
    "</agent_delegation>",
  );
  return lines.join("\n");
}
