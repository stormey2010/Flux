import { assert, describe, it } from "@effect/vitest";

import { DEFAULT_AGENT_PROFILES, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { buildAgentDelegationInstructions } from "./agentDelegation.ts";

describe("buildAgentDelegationInstructions", () => {
  it("renders enabled roles, model fallback policy, and coordinator guidance", () => {
    const [frontend] = DEFAULT_AGENT_PROFILES;
    const profile = {
      ...frontend!,
      id: "frontend",
      name: "Frontend",
      primaryModel: { instanceId: "codex", model: "gpt-5.6-codex" },
      backupModels: [{ instanceId: "claudeAgent", model: "claude-sonnet-5" }],
    };
    const text = buildAgentDelegationInstructions({
      delegationEnabled: true,
      delegationInstructions: "Delegate focused work.",
      agentProfiles: [profile],
    });

    assert.include(text, "<agent_delegation>");
    assert.include(text, "frontend (Frontend)");
    assert.include(text, "codex:gpt-5.6-codex; backups: claudeAgent:claude-sonnet-5");
    assert.include(text, "Delegate focused work.");
  });

  it("returns no prompt when delegation is disabled or no roles are enabled", () => {
    assert.equal(
      buildAgentDelegationInstructions({
        delegationEnabled: false,
        delegationInstructions: DEFAULT_SERVER_SETTINGS.delegationInstructions,
        agentProfiles: DEFAULT_AGENT_PROFILES,
      }),
      "",
    );
    assert.equal(
      buildAgentDelegationInstructions({
        delegationEnabled: true,
        delegationInstructions: DEFAULT_SERVER_SETTINGS.delegationInstructions,
        agentProfiles: DEFAULT_AGENT_PROFILES.map((profile) => ({ ...profile, enabled: false })),
      }),
      "",
    );
  });
});
