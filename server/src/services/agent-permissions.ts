export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canUpdateAgentMetadata: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    // False for every role, including "ceo": CEO access to agent updates comes
    // from the role === "ceo" short-circuit in the routes, not this flag.
    canUpdateAgentMetadata: false,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canUpdateAgentMetadata:
      typeof record.canUpdateAgentMetadata === "boolean"
        ? record.canUpdateAgentMetadata
        : defaults.canUpdateAgentMetadata,
  };
}

// Patch semantics for the permissions record: keys absent from the request keep
// their stored value instead of resetting to the role default — otherwise a
// client sending only the legacy keys would silently revoke every newer flag.
export function mergeAgentPermissionsPatch(
  existing: unknown,
  patch: unknown,
  role: string,
): NormalizedAgentPermissions {
  const base = normalizeAgentPermissions(existing, role);
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return base;
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) overrides[key] = value;
  }
  return normalizeAgentPermissions({ ...base, ...overrides }, role);
}
