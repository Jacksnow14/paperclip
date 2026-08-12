#!/usr/bin/env node
/**
 * SGI Loop H — approval routing (AUR-5354)
 *
 * Loop H used to draft one `request_board_approval` per batch of hypotheses,
 * whatever the hypothesis was. Two of those rows sat in the board queue for 8
 * and 24 days asking the founder to approve **prompt edits to agent
 * instructions** — a question no founder can answer, and one the fleet already
 * has a stronger answer for: `scripts/prompt-edit-gate.mjs` replays the edit
 * blind against real recent tasks and accepts it only if it wins. A board
 * rubber-stamp is a weaker gate than the measurement we already run.
 *
 * So the routing rule is: an experiment arms on a GATE VERDICT, and only
 * reaches the board when the change is genuinely a founder decision — money,
 * credentials, legal, or something irreversible. Everything Loop H actually
 * drafts today (routing / prompt_edit / threshold / agent_assignment) is
 * fleet-internal and gate-routed.
 *
 * This module is pure and importable so the Watchdog and the Hypothesis
 * Drafter share one source of truth (same pattern as
 * sgi-loop-h-experiment-scope.mjs for isolation keys).
 */

/**
 * Change types that are a founder decision by construction. Loop H's own enum
 * (routing | prompt_edit | threshold | agent_assignment) contains none of
 * these — they exist so a future drafter can mark a change as board-bound
 * structurally rather than relying on the wording screen below.
 */
export const FOUNDER_DECISION_CHANGE_TYPES = new Set([
  'spend', 'credential', 'legal', 'irreversible',
]);

/**
 * Narrow wording screen for a change that names a founder decision while
 * carrying a fleet-internal change_type. Deliberately tight: a false positive
 * here refills the board queue, which is the defect being fixed, while a false
 * negative merely sends a change through a measurement gate that is stricter
 * than a board sign-off. Note the absence of "token", "budget cap", "cost" and
 * "priority" — Loop H hypotheses are about token efficiency almost by
 * definition, and matching those would route every experiment to the board.
 */
const FOUNDER_DECISION_PATTERNS = [
  { kind: 'money', re: /\b(spend|spending|purchase|purchasing|buy|buying|subscription|invoice|billing|paid plan|upgrade the plan)\b/i },
  { kind: 'credentials', re: /\b(credential|credentials|secret|secrets|api key|api keys|password|oauth)\b/i },
  { kind: 'legal', re: /\b(legal|contract|contracts|terms of service|license agreement|compliance)\b/i },
  { kind: 'irreversible', re: /\b(irreversible|destructive|delete production|shut down|terminate the)\b/i },
];

/**
 * Where does this experiment's approval belong?
 * @param {{metadata?: object}} record an `experiment/{id}` memory record
 * @returns {{route: 'gate'|'board', reason: string}}
 */
export function routeForExperiment(record) {
  const m = record?.metadata ?? {};
  if (m.requires_founder_decision === true) {
    return { route: 'board', reason: 'explicitly marked requires_founder_decision' };
  }
  if (FOUNDER_DECISION_CHANGE_TYPES.has(String(m.change_type || ''))) {
    return { route: 'board', reason: `change_type "${m.change_type}" is a founder decision` };
  }
  const text = `${m.change || ''} ${m.hypothesis || ''}`;
  for (const { kind, re } of FOUNDER_DECISION_PATTERNS) {
    if (re.test(text)) {
      return { route: 'board', reason: `change names a founder decision (${kind})` };
    }
  }
  return {
    route: 'gate',
    reason: `change_type "${m.change_type || 'unset'}" is fleet-internal — arms on a prompt-edit-gate verdict, not a board row`,
  };
}

/**
 * Find the prompt-edit-gate verdict for an experiment. The link is the diff
 * hash the gate prints and logs: whoever runs the gate stamps
 * `gate_diff_hash` on the experiment record, and this matches it against the
 * `prompt-edit-verdict/{agent}/{date}` records the gate writes. Matching on
 * the hash (not the agent name or a date window) means a verdict can only ever
 * arm the exact edit it judged.
 *
 * @param {{metadata?: object}} record
 * @param {Array<{id?: string, metadata?: object}>} verdictRecords
 * @returns {{verdict: 'accepted'|'rejected'|null, recordId: string|null, diffHash: string|null}}
 */
export function resolveGateVerdict(record, verdictRecords) {
  const diffHash = record?.metadata?.gate_diff_hash || null;
  if (!diffHash) return { verdict: null, recordId: null, diffHash: null };
  const matches = (verdictRecords ?? []).filter(
    (r) => (r?.metadata?.diff_hash ?? null) === diffHash,
  );
  // An accepted verdict wins over an earlier rejection of the same hash: the
  // gate refuses to re-run a rejected diff, so an accepted row for that hash
  // can only come from a later, deliberate re-judgement.
  const accepted = matches.find((r) => r?.metadata?.verdict === 'accepted');
  if (accepted) return { verdict: 'accepted', recordId: accepted.id ?? null, diffHash };
  const rejected = matches.find((r) => r?.metadata?.verdict === 'rejected');
  if (rejected) return { verdict: 'rejected', recordId: rejected.id ?? null, diffHash };
  return { verdict: null, recordId: null, diffHash };
}

/**
 * Pure decision for one gate-routed experiment awaiting arming. No I/O.
 *
 *   gate accepted            -> arm        (status: approved, armed_by prompt_edit_gate)
 *   gate rejected            -> reject     (status: rejected, reason gate_rejected)
 *   no verdict, gate issue filed -> awaiting_gate  (silent, counted)
 *   no verdict, no gate issue    -> needs_gate     (file ONE gate-run issue)
 *
 * @param {{metadata?: object}} record
 * @param {Array} verdictRecords
 * @returns {{action: 'arm'|'reject'|'needs_gate'|'awaiting_gate', reason: string, verdictRecordId: string|null}}
 */
export function decideGateArming(record, verdictRecords) {
  const m = record?.metadata ?? {};
  const { verdict, recordId, diffHash } = resolveGateVerdict(record, verdictRecords);
  if (verdict === 'accepted') {
    return { action: 'arm', reason: `prompt-edit gate ACCEPTED diff ${diffHash}`, verdictRecordId: recordId };
  }
  if (verdict === 'rejected') {
    return { action: 'reject', reason: `prompt-edit gate REJECTED diff ${diffHash}`, verdictRecordId: recordId };
  }
  if (m.gate_issue_id) {
    return {
      action: 'awaiting_gate',
      reason: diffHash
        ? `gate issue ${m.gate_issue_id} filed; no verdict yet for diff ${diffHash}`
        : `gate issue ${m.gate_issue_id} filed; no gate_diff_hash stamped yet`,
      verdictRecordId: null,
    };
  }
  return {
    action: 'needs_gate',
    reason: 'no prompt-edit-gate verdict and no gate run requested yet',
    verdictRecordId: null,
  };
}

/**
 * May this `approved` experiment be activated to `running`?
 * Gate-routed experiments are armed by a gate verdict and must NOT be held for
 * a board approval that will never come; board-routed ones still require an
 * accepted approval.
 *
 * @param {{metadata?: object}} record
 * @param {string|null} approvalStatus status of metadata.board_approval_id, if any
 * @returns {{ok: boolean, reason: string}}
 */
export function decideActivationCredential(record, approvalStatus) {
  const m = record?.metadata ?? {};
  const { route } = routeForExperiment(record);
  if (route === 'gate') {
    if (m.armed_by === 'prompt_edit_gate') {
      return { ok: true, reason: 'armed by prompt-edit gate' };
    }
    return { ok: false, reason: 'gate-routed but not gate-armed' };
  }
  const status = String(approvalStatus || '').toLowerCase();
  if (!m.board_approval_id) return { ok: false, reason: 'approval missing' };
  if (status === 'approved' || status === 'accepted') {
    return { ok: true, reason: `board approval ${status}` };
  }
  return { ok: false, reason: `approval ${status || 'missing'}` };
}
