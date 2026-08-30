import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionChoice,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export const GEMINI_REASONING_EFFORTS = ["high", "medium", "low"] as const;
export type GeminiReasoningEffort = (typeof GEMINI_REASONING_EFFORTS)[number];

const REASONING_LABELS: Record<GeminiReasoningEffort, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function geminiCapabilitiesForEfforts(
  efforts: readonly GeminiReasoningEffort[],
): ModelCapabilities {
  const ordered = GEMINI_REASONING_EFFORTS.filter((effort) => efforts.includes(effort));
  const options: ProviderOptionChoice[] = ordered.map((effort, index) => ({
    id: effort,
    label: REASONING_LABELS[effort],
    ...(index === 0 ? { isDefault: true } : {}),
  }));
  return createModelCapabilities({
    optionDescriptors:
      options.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options,
              currentValue: options[0]?.id,
            },
          ]
        : [],
  });
}

export function resolveGeminiCliModel(
  model: string | undefined,
  modelSelection?: ModelSelection | null,
): string | undefined {
  if (!model) return undefined;
  if (!/^gemini-/iu.test(model) || /-(?:high|medium|low)$/iu.test(model)) return model;
  const selected = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  const effort = GEMINI_REASONING_EFFORTS.includes(selected as GeminiReasoningEffort)
    ? (selected as GeminiReasoningEffort)
    : "high";
  return `${model}-${effort}`;
}

/** Collapse Antigravity's model-per-reasoning-level output into one model. */
export function groupGeminiModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const grouped = new Map<
    string,
    { model: ServerProviderModel; efforts: GeminiReasoningEffort[] }
  >();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const match = model.slug.match(/^(gemini-.+?)-(high|medium|low)$/iu);
    const slug = (match?.[1] ?? model.slug).toLowerCase();
    const effort = match?.[2]?.toLowerCase() as GeminiReasoningEffort | undefined;
    const existing = grouped.get(slug);
    if (existing) {
      if (effort && !existing.efforts.includes(effort)) existing.efforts.push(effort);
      // Prefer the unsuffixed model's cleaner display name/capabilities when
      // it appears after an older cached suffixed entry.
      if (!effort) existing.model = model;
      continue;
    }

    const name = effort
      ? model.name.replace(/\s*\((?:high|medium|low)\)\s*$/iu, "").trim()
      : model.name;
    const entry = {
      model: { ...model, slug, name },
      efforts: effort ? [effort] : [],
    } satisfies { model: ServerProviderModel; efforts: GeminiReasoningEffort[] };
    grouped.set(slug, entry);
    result.push(entry.model);
  }
  return result.map((model) => {
    const entry = grouped.get(model.slug.toLowerCase());
    if (!entry || entry.efforts.length === 0) return model;
    return { ...model, capabilities: geminiCapabilitiesForEfforts(entry.efforts) };
  });
}
