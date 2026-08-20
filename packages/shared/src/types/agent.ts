import type {
  AgentAdapterType,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";

export interface AgentPermissions {
  canCreateAgents: boolean;
  // Narrow grant: metadata-only PATCH /api/agents/:id on other agents
  // (AUR-5026). Optional so existing literal constructors stay valid.
  canUpdateAgentMetadata?: boolean;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "explicit_grant" | "agent_creator" | "ceo_role" | "none";
  canManageRoutines: boolean;
  routineManageSource: "explicit_grant" | "ceo_role" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentAccessSummary {
  id: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  canManageRoutines: boolean;
  routineManageSource: "explicit_grant" | "ceo_role" | "none";
  canAssignTasks: boolean;
  taskAssignSource: "explicit_grant" | "agent_creator" | "ceo_role" | "none";
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

/**
 * AUR-4604: derived-at-read-time execution-blocking state, distinct from
 * `pauseReason`. Unlike `pauseReason` (operator/budget-set, cleared only by
 * an explicit resume), this is recomputed from run history and the clock on
 * every read — `null` the instant a run succeeds or the reset boundary
 * passes, with no writer involved. Deliberately just the two per-agent
 * reasons the classifier can derive from one agent's own run history;
 * `"lane_down"` (a whole provider lane circuit-broken) is a separate,
 * multi-agent rollup exposed on the dedicated `/fleet-capacity` route, not
 * here.
 */
export type AgentQuotaStateReason = "quota_exhausted" | "entitlement_revoked";

export interface AgentQuotaState {
  reason: AgentQuotaStateReason;
  resetAt: string | null;
  detail: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  // Optional (like `defaultEnvironmentId`) so pre-existing fixtures/mocks
  // across the codebase don't need updating; the real agent service always
  // sets it explicitly (AUR-4604).
  quotaState?: AgentQuotaState | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export interface AgentKeyCreated {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
