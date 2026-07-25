/**
 * Shared eligibility predicate for the routing-rationale registry
 * (`routing/{identifier}` memory records, metadata.category "routing_rationale").
 *
 * Used by both the auto-stamp path (server writes a skeleton record at
 * assignment time — AUR-3987b) and the watchdog that flags missing records
 * (AUR-3987a). Both must agree on what counts as "a routing decision was
 * made" or the watchdog will flag issues the auto-stamp already covers
 * (false positives) or miss issues it doesn't (false negatives). Change
 * this in one place, not two.
 */
export interface RoutingRationaleAssignmentInput {
  priority?: string | null;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  originKind?: string | null;
}

const ELIGIBLE_PRIORITIES = new Set(["high", "critical"]);

/**
 * True when a `high`/`critical` issue was routed by a manager agent to a
 * different agent via a normal (non-routine, non-system) assignment — the
 * class of decision the routing-rationale registry exists to record.
 * False for self-assigned issues, routine/system-originated issues (no
 * creator agent, or an automated origin), and unassigned/low-priority ones.
 */
export function isRoutingRationaleAutoStampEligible(
  issue: RoutingRationaleAssignmentInput,
): boolean {
  if (!issue.priority || !ELIGIBLE_PRIORITIES.has(issue.priority)) return false;
  if (!issue.assigneeAgentId) return false;
  if (!issue.createdByAgentId) return false;
  if (issue.createdByAgentId === issue.assigneeAgentId) return false;
  if (issue.originKind && issue.originKind !== "manual") return false;
  return true;
}
