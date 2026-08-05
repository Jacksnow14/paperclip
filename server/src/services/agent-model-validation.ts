// AUR-4689: config-time validation of adapterConfig.model against the
// adapter's available-model list, plus a periodic sweep over existing agents.
//
// Incident: Junior Coder's configured model (gpt-5.3-codex) was retired by the
// provider *after* config time. Nothing validated it, so the agent burned 34
// consecutive runs with a provider 400 before any work happened. This module
// provides both halves of the missing guard:
//   - checkConfiguredModelAvailability: used by agent create/PATCH to reject a
//     bogus model id at write time, naming the valid ids.
//   - sweepAgentConfiguredModels: used by a startup + periodic scheduler to
//     flag agents whose stored model has since disappeared from the list —
//     the half that would have caught the actual incident.
//
// Fail-open doctrine: if the model list cannot be fetched (provider down, no
// API key), the check reports "unvalidated" — callers log a warning and allow
// the write. A validator that hard-fails on its own outage is worse than none.

import { listAdapterModels } from "../adapters/index.js";

export interface AdapterModelListDeps {
  listModels?: (adapterType: string) => Promise<{ id: string; label: string }[]>;
}

export type ConfiguredModelCheck =
  | { outcome: "valid"; validIds: string[] }
  | { outcome: "invalid"; validIds: string[] }
  | { outcome: "unvalidated"; reason: "empty-model-list" | "model-list-unavailable"; error?: unknown };

export async function checkConfiguredModelAvailability(
  adapterType: string,
  model: string,
  deps?: AdapterModelListDeps,
): Promise<ConfiguredModelCheck> {
  const listModels = deps?.listModels ?? listAdapterModels;
  let models: { id: string; label: string }[];
  try {
    models = await listModels(adapterType);
  } catch (error) {
    return { outcome: "unvalidated", reason: "model-list-unavailable", error };
  }
  if (!Array.isArray(models) || models.length === 0) {
    // Adapters without a model list (process, http, unknown/external types)
    // cannot be validated — allow rather than block on missing knowledge.
    return { outcome: "unvalidated", reason: "empty-model-list" };
  }
  const validIds = models.map((entry) => entry.id);
  return validIds.includes(model)
    ? { outcome: "valid", validIds }
    : { outcome: "invalid", validIds };
}

export function formatInvalidModelMessage(adapterType: string, model: string, validIds: string[]): string {
  return (
    `adapterConfig.model '${model}' is not in the available model list for adapter '${adapterType}'. `
    + `Valid model ids: ${validIds.join(", ")}`
  );
}

export interface AgentModelSweepRow {
  id: string;
  name: string;
  companyId: string;
  status: string;
  adapterType: string;
  model: string | null;
}

export interface AgentModelSweepFlag {
  agentId: string;
  agentName: string;
  companyId: string;
  adapterType: string;
  model: string;
  validIds: string[];
}

export interface AgentModelSweepResult {
  checkedCount: number;
  flagged: AgentModelSweepFlag[];
  /** Adapter types whose model list could not be fetched — those agents were skipped (fail-open). */
  unvalidatedAdapterTypes: string[];
}

/**
 * Flag every non-terminated agent whose configured model is absent from its
 * adapter's current available-model list. Fetches each adapter's list once.
 */
export async function sweepAgentConfiguredModels(
  agents: AgentModelSweepRow[],
  deps?: AdapterModelListDeps,
): Promise<AgentModelSweepResult> {
  const listModels = deps?.listModels ?? listAdapterModels;
  const candidates = agents.filter(
    (agent) => agent.status !== "terminated" && typeof agent.model === "string" && agent.model.trim().length > 0,
  );

  const modelListByAdapterType = new Map<string, { validIds: string[] } | { failed: true }>();
  for (const adapterType of new Set(candidates.map((agent) => agent.adapterType))) {
    try {
      const models = await listModels(adapterType);
      modelListByAdapterType.set(
        adapterType,
        Array.isArray(models) && models.length > 0
          ? { validIds: models.map((entry) => entry.id) }
          : { failed: true },
      );
    } catch {
      modelListByAdapterType.set(adapterType, { failed: true });
    }
  }

  const flagged: AgentModelSweepFlag[] = [];
  let checkedCount = 0;
  for (const agent of candidates) {
    const listing = modelListByAdapterType.get(agent.adapterType);
    if (!listing || "failed" in listing) continue;
    checkedCount += 1;
    const model = (agent.model as string).trim();
    if (!listing.validIds.includes(model)) {
      flagged.push({
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        model,
        validIds: listing.validIds,
      });
    }
  }

  return {
    checkedCount,
    flagged,
    unvalidatedAdapterTypes: Array.from(modelListByAdapterType.entries())
      .filter(([, listing]) => "failed" in listing)
      .map(([adapterType]) => adapterType),
  };
}
