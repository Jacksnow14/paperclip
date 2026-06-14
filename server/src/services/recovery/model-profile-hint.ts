// Recovery no longer force-pins a cheap model profile (AUR-2248).
// Helpers kept as no-ops so all call sites compile without changes.
// The "cheap" profile itself is unchanged in adapter config.

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(input: T): T {
  return input;
}

export function recoveryAssigneeAdapterOverrides(): Record<string, never> {
  return {};
}
