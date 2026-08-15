// AUR-5734 — the "second sink" guard. This exercises the real subprocess
// mechanism (execFile -> node --import tsx/esm -> check-recipient.ts) against
// the actual, unmerged Auranode script (stacked PR #168 on PR #167), not a
// mock of it — per the artifact-provenance bar, a mocked subprocess would
// only prove the mock's contract, not that this route actually consults the
// same truth the dispatcher does. Both a FIRE case (a machine-only address is
// refused) and a PASS case (an ordinary prospect still sends) are covered, so
// this guard is proven to clear as well as to fire.
//
// Depends on a colocated Auranode checkout at AURANODE_WORKTREE below having
// the AUR-5734 check-recipient.ts script (branch aur5734-check-recipient-guard,
// PR #168) and a working tsx install. If that worktree is absent — e.g. a
// fresh clone of this repo alone, without the sibling Auranode checkout — this
// suite skips itself rather than failing the whole run on an environment gap
// unrelated to Paperclip.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkProspectSendability, GmailProspectSuppressedError } from "../services/gmail-prospect-guard.js";

const AURANODE_WORKTREE = "/home/ievgen/Auranode-aur3864";
const CHECK_RECIPIENT_SCRIPT = join(
  AURANODE_WORKTREE,
  "packages/tools/email-deliverability/src/check-recipient.ts",
);
const HAS_AURANODE_FIXTURE = existsSync(CHECK_RECIPIENT_SCRIPT);

const describeIfFixture = HAS_AURANODE_FIXTURE ? describe : describe.skip;

let seq = 0;
function replyLine(from: string, replyClass: string): string {
  return JSON.stringify({
    id: `msg-${seq++}`,
    threadId: "t",
    date: "2026-07-04T00:00:00Z",
    from,
    subject: "s",
    snippet: "",
    replyClass,
    campaign: null,
    sentAt: null,
    matched: true,
    harvestedAt: "2026-08-15T00:00:00Z",
  });
}

describeIfFixture("checkProspectSendability — AUR-5734 second-sink guard (real subprocess)", () => {
  let stateDir: string;
  let prevRepoDir: string | undefined;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = join(tmpdir(), `aur5734-paperclip-gmail-guard-${process.pid}-${Date.now()}`);
    mkdirSync(join(stateDir, "email-deliverability"), { recursive: true });
    prevRepoDir = process.env.AURANODE_REPO_DIR;
    prevStateDir = process.env.AURANODE_STATE_DIR;
    process.env.AURANODE_REPO_DIR = AURANODE_WORKTREE;
    process.env.AURANODE_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevRepoDir === undefined) delete process.env.AURANODE_REPO_DIR;
    else process.env.AURANODE_REPO_DIR = prevRepoDir;
    if (prevStateDir === undefined) delete process.env.AURANODE_STATE_DIR;
    else process.env.AURANODE_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it(
    "FIRE: refuses a mailbox that answered twice, both times with a machine, naming the evidence",
    async () => {
      writeFileSync(
        join(stateDir, "email-deliverability", "reply-events.jsonl"),
        [replyLine("queue@example.com", "auto_ack"), replyLine("queue@example.com", "auto_ack")].join("\n") + "\n",
      );

      const verdict = await checkProspectSendability("queue@example.com");
      expect(verdict).not.toBeNull();
      expect(verdict!.sendable).toBe(false);
      expect(verdict!.source).toBe("suppression");
      expect(verdict!.reason).toMatch(/machine-only mailbox: 2 automated replies, 0 human/);

      const err = new GmailProspectSuppressedError(verdict!);
      expect(err.message).toContain("queue@example.com");
      expect(err.message).toContain("account is not disqualified");
    },
    20_000,
  );

  it(
    "PASS: an ordinary prospect with no reply history still sends",
    async () => {
      const verdict = await checkProspectSendability("jane.doe@example.org");
      expect(verdict).not.toBeNull();
      expect(verdict!.sendable).toBe(true);
      expect(verdict!.reason).toBeNull();
    },
    20_000,
  );

  it(
    "refuses a role/system mailbox via the non-prospect check",
    async () => {
      const verdict = await checkProspectSendability("billing@example.com");
      expect(verdict).not.toBeNull();
      expect(verdict!.sendable).toBe(false);
      expect(verdict!.source).toBe("non-prospect");
    },
    20_000,
  );
});

describe("checkProspectSendability — fails open, loudly, when the check cannot run", () => {
  let prevRepoDir: string | undefined;

  beforeEach(() => {
    prevRepoDir = process.env.AURANODE_REPO_DIR;
    process.env.AURANODE_REPO_DIR = "/nonexistent/does-not-exist-aur5734";
  });

  afterEach(() => {
    if (prevRepoDir === undefined) delete process.env.AURANODE_REPO_DIR;
    else process.env.AURANODE_REPO_DIR = prevRepoDir;
  });

  it("returns null instead of throwing when the Auranode checkout/script is missing", async () => {
    const verdict = await checkProspectSendability("someone@example.com");
    expect(verdict).toBeNull();
  });
});
