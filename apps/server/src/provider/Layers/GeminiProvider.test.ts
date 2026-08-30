import { describe, expect, it } from "@effect/vitest";

import { decodeAntigravityEvent } from "./GeminiAdapter.ts";
import { parseAntigravityModels } from "./GeminiProvider.ts";
import { groupGeminiModels } from "../geminiModel.ts";
import { parseGeminiUsageOutput } from "../../usage/geminiQuota.ts";

describe("Gemini Antigravity integration", () => {
  it("parses Gemini models and ignores other Antigravity models", () => {
    const models = parseAntigravityModels(`
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
      `);
    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
      { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    ]);
    expect(models[0]!.capabilities?.optionDescriptors?.[0] ?? {}).toMatchObject({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "high",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "medium", label: "Medium" },
      ],
    });
  });

  it("deduplicates base models and legacy suffixed cache entries", () => {
    const models = groupGeminiModels([
      {
        slug: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash (High)",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "gemini-3.7-flash-medium",
        name: "Gemini 3.7 Flash (Medium)",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("gemini-3.7-flash");
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      options: [{ id: "high" }, { id: "medium" }],
    });
  });

  it("parses Antigravity usage percentages and reset times", () => {
    const meters = parseGeminiUsageOutput(
      "Gemini Models\tWeekly Limit Remaining\t82.5%\t2026-09-03T03:33:50Z\n" +
        "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-08-27T08:33:50Z",
    );
    expect(meters).toMatchObject([
      { id: "weekly", label: "Weekly", remainingPercent: 82.5, usedPercent: 17.5 },
      { id: "five-hour", label: "Five Hour", remainingPercent: 100, usedPercent: 0 },
    ]);
    expect(meters[0]?.resetsAt).toBe("2026-09-03T03:33:50.000Z");
  });

  it("decodes incremental response and tool events", () => {
    const response = decodeAntigravityEvent(
      '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello"}}',
    );
    const tool = decodeAntigravityEvent(
      '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pnpm test"},"output":"ok"}}}',
    );

    expect(response?.event).toBe("step_update");
    expect(response?.event === "step_update" ? response.step_update.text_delta : undefined).toBe(
      "Hello",
    );
    expect(tool?.event === "step_update" ? tool.step_update.tool_name : undefined).toBe(
      "run_command",
    );
  });

  it("decodes a terminal result with subscription token usage", () => {
    const event = decodeAntigravityEvent(
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Done\\n","usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":5,"cache_read_tokens":50,"total_tokens":125}}}',
    );

    expect(event?.event).toBe("result");
    expect(event?.event === "result" ? event.result.usage?.total_tokens : undefined).toBe(125);
  });
});
