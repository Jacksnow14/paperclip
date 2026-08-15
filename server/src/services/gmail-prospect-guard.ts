// gmail-prospect-guard.ts
//
// AUR-5734 — the "second sink" guard. AUR-3864 (machine-only suppression),
// AUR-4307 (unified bounce suppression), and AUR-3749 (non-prospect filter)
// only reach the Resend/dispatcher send path inside the Auranode
// email-deliverability CLI. The Paperclip Gmail route is a second path that
// can reach an external prospect directly — driven by an agent, not the CLI —
// and never consulted that truth. The Help at Home `coupa@` touches on
// 2026-07-25 and 2026-07-29 (including the "corrected, To-header verified"
// resend) went out exactly this way and would still go out today.
//
// This module shells out to the Auranode repo's check-recipient.ts, which
// imports (does not re-implement) loadUnifiedSuppression() and
// nonProspectReason() from packages/tools/email-deliverability. Paperclip and
// Auranode are independently deployed repos with no shared package graph —
// they are colocated on this host (see /opt/paperclip/app/current and
// /home/ievgen/Auranode) but versioned and released separately — so a
// subprocess call into the canonical Auranode checkout is the reuse seam
// that avoids growing a second, driftable copy of the predicate here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

const DEFAULT_AURANODE_REPO_DIR = "/home/ievgen/Auranode";
// tsx is installed under this package's own node_modules (pnpm workspace
// layout), not hoisted to the repo root, and `--import tsx/esm` resolves
// against cwd — so the subprocess must run with cwd set to the package dir,
// not the repo root, or module resolution for "tsx/esm" itself fails.
const CHECK_RECIPIENT_PACKAGE_RELATIVE_DIR = "packages/tools/email-deliverability";
const CHECK_RECIPIENT_SCRIPT_RELATIVE_PATH = "src/check-recipient.ts";
const CHECK_TIMEOUT_MS = 10_000;

export interface ProspectSuppressionVerdict {
  address: string;
  /** False iff this address must not be sent to over this route. */
  sendable: boolean;
  /** Human-readable evidence, or null when sendable. */
  reason: string | null;
  source: "non-prospect" | "suppression" | null;
}

function auranodeRepoDir(): string {
  return process.env.AURANODE_REPO_DIR?.trim() || DEFAULT_AURANODE_REPO_DIR;
}

function isWellFormedVerdict(value: unknown): value is ProspectSuppressionVerdict {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.address === "string" && typeof v.sendable === "boolean";
}

/**
 * Consult the SAME truth the Auranode dispatcher does before sending to an
 * external recipient. Returns `null` only when the check itself could not be
 * run at all (missing checkout, timeout, malformed output) — this is always
 * logged at error level, never silent, and the caller treats it as "unable
 * to verify" rather than either a pass or a refusal.
 *
 * A `null` result deliberately does not block the send. The underlying
 * predicate is itself fail-open by design (silence is not evidence a mailbox
 * is machine-only — see machine-only-suppression.ts Rule 3); an infra hiccup
 * on THIS side is a weaker signal than that, and hard-blocking every external
 * Gmail send whenever the Auranode checkout is briefly unavailable would be a
 * worse outage than the one this guard exists to prevent. It is the caller's
 * job to make that failure loud (see gmail.ts), not this function's job to
 * fail closed.
 */
export async function checkProspectSendability(to: string): Promise<ProspectSuppressionVerdict | null> {
  const repoDir = auranodeRepoDir();
  const packageDir = `${repoDir}/${CHECK_RECIPIENT_PACKAGE_RELATIVE_DIR}`;
  const scriptPath = `${packageDir}/${CHECK_RECIPIENT_SCRIPT_RELATIVE_PATH}`;
  try {
    const { stdout } = await execFileAsync("node", ["--import", "tsx/esm", scriptPath, to], {
      cwd: packageDir,
      timeout: CHECK_TIMEOUT_MS,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isWellFormedVerdict(parsed)) {
      throw new Error(`malformed verdict shape: ${stdout.trim().slice(0, 200)}`);
    }
    return parsed;
  } catch (err) {
    logger.error(
      { err, to, repoDir, scriptPath },
      "gmail-prospect-guard: could not run check-recipient.ts (AUR-5734) — this send is NOT verified against machine-only/non-prospect/bounce suppression",
    );
    return null;
  }
}

export class GmailProspectSuppressedError extends Error {
  readonly verdict: ProspectSuppressionVerdict;
  constructor(verdict: ProspectSuppressionVerdict) {
    const sourceLabel = verdict.source === "suppression" ? "suppression evidence" : "non-prospect check";
    super(
      `BLOCKED: recipient ${verdict.address} is not a sendable prospect over this route (AUR-5734 guardrail). ` +
        `${sourceLabel}: ${verdict.reason}. The account is not disqualified — only this automated route into it. ` +
        `Use a different, verified human contact instead of resending to this address.`,
    );
    this.name = "GmailProspectSuppressedError";
    this.verdict = verdict;
  }
}
