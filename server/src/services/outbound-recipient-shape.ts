// outbound-recipient-shape.ts
//
// AUR-5732 — prospecting outbound must reach a HUMAN, not a ticket queue.
//
// Root cause: every one of the 18 AUR-681 contact paths was a role, queue, or
// shared inbox. `Coupa@helpathome.com` turned out to be Help at Home's "Great
// Support" helpdesk queue: each of our ~9 touches auto-opened a new support
// ticket, and on 2026-08-11 an agent closed and merged five of them into an
// unrelated landscaping-invoice ticket. We were triaged as queue noise. Several
// tracker rows named a real target human and then mailed a queue instead.
//
// AUR-4479 made a To:-header read-back a condition of closure, but the question
// it asked was "is the recipient not us?" — never "is the recipient the
// prospect?". So the 2026-07-29 Help at Home resend passed verification while
// going straight back into the ticket queue. Same family as every other
// fail-open sensor in this codebase: the success signal was not the same object
// as the outcome.
//
// This module adds the two missing questions:
//
//   1. RECIPIENT SHAPE — does this address look like a queue rather than a
//      person? A prospecting send to a queue must explicitly justify itself.
//   2. INTENDED RECIPIENT — does the address we are ACTUALLY about to send to
//      equal the address the caller says it intended? On a threaded reply the
//      recipient is *resolved*, not chosen, so this is the only check that can
//      catch resolution landing back on a queue.
//
// Both are opt-in per send (`prospecting` / `intendedRecipient`) rather than
// blanket-on: replying to a support queue that mailed US first is legitimate,
// and transactional/internal mail is not prospecting.

/** How a recipient address reads: a queue/role/shared inbox, or a person. */
export type RecipientShape = "role_inbox" | "named_human";

export interface RecipientShapeVerdict {
  /** Bare address, lowercased, display name stripped. */
  address: string;
  localPart: string;
  domain: string;
  shape: RecipientShape;
  /** Which rule fired, for auditability. Null when shape is named_human. */
  matchedRule: string | null;
}

// Tier 1 — the literal pattern named in AUR-5732's acceptance criteria.
// Anchored at the start of the local part.
export const ROLE_LOCAL_PREFIX_RE =
  /^(info|press|coupa|suppliers?|procurement|procurementops|supplierenablement|support|enquiries|.*support.*)$/i;

// Tier 2 — the anchored pattern above misses the way these mailboxes are
// actually named in the wild. Real observed AUR-681 addresses that tier 1 does
// NOT catch: `admcoupa@adm.com`, `newbusinessenquiries@britvic.com`,
// `pressenquiries@wshlimited.com`, `comptesfournisseurs@olymel.com`,
// `esg-sustainability@molsoncoors.com`, `vendor.inquiry@pactgroup.com`,
// `coupasupplierenablement@sonoco.com`. Corporate role mailboxes concatenate
// department words, so match on token SUBSTRING, not on prefix.
//
// Recall is deliberately favoured over precision. A false positive costs the
// caller one extra field (`queueJustification`); a false negative costs ten
// weeks of outreach into a ticket queue, which is what actually happened.
const ROLE_TOKENS: ReadonlyArray<string> = [
  // procurement / P2P
  "coupa",
  "ariba",
  "procure",
  "purchas",
  "source", // sourcing / sourcedwithpurpose@wshsupport.com
  "supplier",
  "vendor",
  "approvisionnement", // FR: procurement (Olymel)
  "fournisseur", // FR: supplier / comptesfournisseurs (Olymel)
  "accountspayable",
  "accountpayable",
  "payables",
  // service desks
  "support",
  "helpdesk",
  "servicedesk",
  "ticket",
  // generic shared inboxes
  "info",
  "contact",
  "hello",
  "enquir", // enquiry / enquiries
  "inquir", // inquiry / inquiries
  "admin",
  "office",
  "mailbox",
  "team",
  // wrong-department inboxes we actually mailed
  "press",
  "media",
  "newsroom",
  "sustainability",
  "esg",
  "logistics",
  // other departmental catch-alls
  "sales",
  "marketing",
  "billing",
  "invoice",
  "finance",
  "legal",
  "careers",
  "recruit",
  "hr@",
  // automated
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "webmaster",
  "abuse",
];

// A helpdesk domain makes the whole mailbox a queue regardless of local part —
// `sourcedwithpurpose@wshsupport.com` is WSH's ticketing domain, and Help at
// Home's queue documentation lives on support.helpathome.com. Matched per
// dot-separated label so `helpathome.com` itself is untouched.
const ROLE_DOMAIN_TOKENS: ReadonlyArray<string> = [
  "support",
  "helpdesk",
  "servicedesk",
  "zendesk",
  "freshdesk",
  "servicenow",
  "ticket",
];

// Local parts that ARE the whole role, with no distinguishing token above.
const ROLE_EXACT: ReadonlySet<string> = new Set([
  "ap",
  "hr",
  "it",
  "pr",
  "cs",
  "csr",
  "general",
  "main",
  "all",
  "everyone",
  "staff",
  "reception",
]);

/** Strip a display name / angle brackets and lowercase. `A B <a@b.c>` → `a@b.c`. */
export function normalizeAddress(raw: string): string {
  const angled = /<([^<>]+)>/.exec(raw ?? "");
  const bare = (angled ? angled[1] : (raw ?? "")).trim().toLowerCase();
  return bare.replace(/^[,;\s]+|[,;\s.]+$/g, "");
}

/**
 * Classify a single recipient address as a role/queue inbox or a named human.
 *
 * Not a hard block on its own — it decides whether a prospecting send has to
 * justify itself. See assertProspectingRecipient.
 */
export function classifyRecipientShape(raw: string): RecipientShapeVerdict {
  const address = normalizeAddress(raw);
  const at = address.lastIndexOf("@");
  const localPart = at === -1 ? address : address.slice(0, at);
  const domain = at === -1 ? "" : address.slice(at + 1);

  if (ROLE_LOCAL_PREFIX_RE.test(localPart)) {
    return { address, localPart, domain, shape: "role_inbox", matchedRule: "aur5732-prefix" };
  }
  if (ROLE_EXACT.has(localPart)) {
    return { address, localPart, domain, shape: "role_inbox", matchedRule: `exact:${localPart}` };
  }
  for (const token of ROLE_TOKENS) {
    if (localPart.includes(token)) {
      return { address, localPart, domain, shape: "role_inbox", matchedRule: `token:${token}` };
    }
  }
  for (const label of domain.split(".")) {
    for (const token of ROLE_DOMAIN_TOKENS) {
      if (label.includes(token)) {
        return { address, localPart, domain, shape: "role_inbox", matchedRule: `domain:${token}` };
      }
    }
  }
  return { address, localPart, domain, shape: "named_human", matchedRule: null };
}

function splitRecipients(values: Array<string | string[] | undefined>): string[] {
  return values
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .flatMap((v) => v.split(/[,;]+/))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Classify every address across a to/cc set. */
export function classifyRecipientSet(
  values: Array<string | string[] | undefined>,
): RecipientShapeVerdict[] {
  return splitRecipients(values).map(classifyRecipientShape);
}

export class ProspectingRecipientError extends Error {
  readonly verdicts: RecipientShapeVerdict[];
  constructor(message: string, verdicts: RecipientShapeVerdict[] = []) {
    super(message);
    this.name = "ProspectingRecipientError";
    this.verdicts = verdicts;
  }
}

/** A justification has to say something; a single space is not a reason. */
const MIN_JUSTIFICATION_CHARS = 20;

/**
 * How confident we are that a recipient address actually reaches the person
 * it is asserted to reach — orthogonal to RecipientShape, which only says
 * whether the address FORMAT looks like a person.
 *
 * AUR-5735 wrote six addresses at `pattern_hypothesis`: human-shaped,
 * derived from a confirmed org email pattern (e.g. first.last@domain), but
 * never observed for that specific person. Every one of them classifies as
 * `named_human` and trivially satisfies `recipientPersonName` — neither
 * check says anything about whether the mailbox exists or belongs to them.
 */
export type EvidenceGrade = "verified" | "pattern_hypothesis" | "queue_only_confirmed" | "none";

// Grades that clear the bar without an explicit evidenceJustification. An
// omitted or unrecognized grade is treated the same as the weakest grade —
// fail closed, matching the posture of an unjustified queue send below.
// AUR-5735 defines "verified" as the only grade an address was actually
// observed at (header, signed document, org directory, or a confirmed
// person/switchboard reply) — the one grade this guard may clear on its own.
const VERIFIED_EVIDENCE_GRADES: ReadonlySet<string> = new Set<EvidenceGrade>(["verified"]);

// A justification can only override a grade the caller has actually named.
// An unset/unrecognized grade is not "a weaker grade" to be excused — it is
// no assertion at all, and must fail regardless of justification length.
const KNOWN_NON_VERIFIED_EVIDENCE_GRADES: ReadonlySet<string> = new Set<EvidenceGrade>([
  "pattern_hypothesis",
  "queue_only_confirmed",
  "none",
]);

export interface ProspectingRecipientInput {
  to: string;
  cc?: string | string[];
  /** The human this send is for, e.g. "Zachary Welsher". */
  recipientPersonName?: string;
  /** Why a queue/role inbox is nonetheless the right target for this send. */
  queueJustification?: string;
  /**
   * How the caller knows this address reaches `recipientPersonName`, e.g.
   * "verified" | "pattern_hypothesis" | "queue_only_confirmed" | "none". Only
   * `verified` clears the bar on its own; anything else needs
   * `evidenceJustification`. Required whenever a named-human address is in
   * play — see AUR-5735/AUR-5737.
   */
  evidenceGrade?: string;
  /** Why sending on non-verified evidence is nonetheless correct for this send. */
  evidenceJustification?: string;
}

/**
 * Gate a COLD PROSPECTING send. Throws ProspectingRecipientError unless the
 * caller has either named the human being written to or explicitly justified
 * writing to a queue, AND — for any named-human address — asserted verified
 * evidence that the address actually reaches that person.
 *
 * Rules:
 *  - Any role/queue-shaped recipient (to or cc) requires `queueJustification`.
 *    Naming a human does NOT excuse it: the whole AUR-5732 failure was rows
 *    that named a target human and then mailed the queue anyway.
 *  - A send with no role-shaped recipient still has to carry one of the two
 *    fields, so "who is this for?" is answered before the send, not after.
 *  - Any named-human recipient requires evidenceGrade: "verified", or
 *    evidenceJustification (>= MIN_JUSTIFICATION_CHARS) if the evidence is
 *    weaker than that. `recipientPersonName` alone proves nothing — AUR-5735
 *    generated six plausible-but-unverified candidates that would otherwise
 *    sail through on that field alone.
 */
export function assertProspectingRecipient(input: ProspectingRecipientInput): RecipientShapeVerdict[] {
  const verdicts = classifyRecipientSet([input.to, input.cc]);
  if (verdicts.length === 0) {
    throw new ProspectingRecipientError("Refusing to send: prospecting send has no recipients.");
  }

  const justification = (input.queueJustification ?? "").trim();
  const personName = (input.recipientPersonName ?? "").trim();
  const queues = verdicts.filter((v) => v.shape === "role_inbox");
  const namedHumans = verdicts.filter((v) => v.shape === "named_human");

  if (queues.length > 0 && justification.length < MIN_JUSTIFICATION_CHARS) {
    throw new ProspectingRecipientError(
      `Refusing to send: prospecting recipient(s) ${queues
        .map((q) => `${q.address} (${q.matchedRule})`)
        .join(", ")} look like a role/queue/shared inbox, not a named human. ` +
        `Every AUR-681 contact path was a queue like this and the outreach was triaged as ticket ` +
        `noise (AUR-5732). Re-derive a named human's work address, or pass ` +
        `queueJustification (>= ${MIN_JUSTIFICATION_CHARS} chars) stating why the queue is the ` +
        `correct target for this specific send.`,
      verdicts,
    );
  }

  if (queues.length === 0 && !personName && justification.length < MIN_JUSTIFICATION_CHARS) {
    throw new ProspectingRecipientError(
      `Refusing to send: prospecting send must name the human it is for. ` +
        `Pass recipientPersonName (or queueJustification if this is deliberately a shared inbox).`,
      verdicts,
    );
  }

  const evidenceGrade = (input.evidenceGrade ?? "").trim();
  const evidenceJustification = (input.evidenceJustification ?? "").trim();
  if (namedHumans.length > 0 && !VERIFIED_EVIDENCE_GRADES.has(evidenceGrade)) {
    // A justification only excuses a grade the caller actually asserted.
    // Skipping evidenceGrade entirely is not "a weaker grade" — it is no
    // assertion at all, and evidenceJustification cannot stand in for it.
    const overridden =
      KNOWN_NON_VERIFIED_EVIDENCE_GRADES.has(evidenceGrade) &&
      evidenceJustification.length >= MIN_JUSTIFICATION_CHARS;
    if (!overridden) {
      throw new ProspectingRecipientError(
        `Refusing to send: recipient evidence grade is not verified (evidenceGrade=` +
          `${evidenceGrade || "unset"}) for ${namedHumans.map((h) => h.address).join(", ")}. ` +
          `AUR-5735 wrote six human-shaped but unverified addresses this way — e.g. ` +
          `abbey.jones@sonoco.com, derived from a confirmed org pattern but never observed for ` +
          `that person — and every one of them would pass this guard on recipientPersonName alone. ` +
          `Pass evidenceGrade: "verified" once the address is directly observed (a ` +
          `reply, a byline, a first-party mailbox hit), or an explicit non-verified ` +
          `evidenceGrade (e.g. "pattern_hypothesis") plus evidenceJustification (>= ` +
          `${MIN_JUSTIFICATION_CHARS} chars) stating why sending on unverified evidence is the ` +
          `correct call for this specific send.`,
        verdicts,
      );
    }
  }

  return verdicts;
}

export class IntendedRecipientMismatchError extends Error {
  readonly intended: string;
  readonly actual: string;
  constructor(intended: string, actual: string, context?: string) {
    super(
      `Refusing to send: resolved recipient does not match the intended prospect. ` +
        `intended=${intended} actual=${actual}${context ? ` (${context})` : ""}. ` +
        `AUR-4479's read-back only proved the recipient was not us; AUR-5732 requires it to be ` +
        `the prospect recorded on the tracker row. A threaded reply resolves its recipient from ` +
        `the thread, so a queue auto-responder in the thread silently redirects the send.`,
    );
    this.name = "IntendedRecipientMismatchError";
    this.intended = normalizeAddress(intended);
    this.actual = normalizeAddress(actual);
  }
}

/**
 * AUR-5732 extension of the AUR-4479 read-back: assert that the address we are
 * about to put in To: is the address the caller intended, not merely "not us".
 * Compares bare addresses, so display names and casing do not matter.
 */
export function assertIntendedRecipient(
  actualTo: string,
  intended: string,
  context?: string,
): void {
  const actual = normalizeAddress(actualTo);
  const want = normalizeAddress(intended);
  if (!want) return;
  if (actual !== want) {
    throw new IntendedRecipientMismatchError(want, actual, context);
  }
}
