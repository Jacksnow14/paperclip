import assert from "node:assert/strict";
import test from "node:test";

import { isExempt, isRoutingDecision } from "./check-routing-rationale.mjs";

// AUR-4997 acceptance criterion: a filed disk alert must not be picked up by
// the routing-rationale watchdog. `isExempt` (the function the watchdog
// actually calls) must return true for the exact shape the disk-monitor
// alerter files: no createdByAgentId, originKind "disk_alert", and the
// "exec.routing-rationale: skip" marker in the description as a
// belt-and-braces second layer.
function diskAlertIssue(overrides = {}) {
  return {
    title: "[DISK ALERT] Disk usage critical: 92.3%",
    description: "## Disk High-Water-Mark Alert\n\n...\n\nexec.routing-rationale: skip",
    originKind: "disk_alert",
    createdByAgentId: null,
    assigneeAgentId: "ceo-agent-id",
    ...overrides,
  };
}

test("a disk alert issue is exempt from routing rationale", () => {
  const issue = diskAlertIssue();
  assert.equal(isExempt(issue), true);
});

test("originKind alone (no createdByAgentId either) already makes isRoutingDecision false", () => {
  const issue = diskAlertIssue();
  assert.equal(isRoutingDecision(issue), false);
});

test("still exempt even if createdByAgentId were somehow set, via the skip marker", () => {
  // Belt-and-braces: even if a future change starts attributing
  // createdByAgentId to the alerter's own agent id, the explicit skip marker
  // in the description keeps it exempt independently of originKind.
  const issue = diskAlertIssue({ createdByAgentId: "disk-monitor-system-agent" });
  assert.equal(isExempt(issue), true);
});

test("still exempt via originKind alone if the skip marker were absent", () => {
  const issue = diskAlertIssue({ description: "## Disk High-Water-Mark Alert\n\n..." });
  assert.equal(isExempt(issue), true);
});
