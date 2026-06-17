// gmail-outbound-guard.ts
//
// HARD CONTROL — gate Gmail-mailbox outbound fraud/abuse/legal/chargeback/
// law-enforcement reports at the control-plane level.
//
// Root cause: AUR-2525. The 2026-06-16 false "account takeover" cascade
// (First Mile Coffee) was sent via the alex@ Gmail send API on this control
// plane at 18:23:55 UTC — NOT via Resend. AUR-2521 guarded the Resend path;
// this module guards the Gmail path, which was the actual exploited path.
//
// Inbound triage and INTERNAL incident issues are unaffected. Only external,
// accusatory/legal/fraud/chargeback/law-enforcement sends are gated.

export type GmailOutboundCategory =
  | 'fraud_report'
  | 'abuse_report'
  | 'legal_threat'
  | 'chargeback'
  | 'law_enforcement'
  | 'blocked_domain';

export interface GmailOutboundCheckInput {
  to: string;
  subject?: string;
  text?: string;
  cc?: string[];
}

export interface GmailOutboundDecision {
  category: GmailOutboundCategory | null;
  external: boolean;
  gated: boolean;
  reasons: string[];
}

const INTERNAL_DOMAIN = 'tryauranode.com';

// Absolute recipient domain blocklist (LAR-255 / 9227 First Mile case).
// All sends to these domains are blocked regardless of content or recipient type.
// The only override is an explicit CEO board approval (ceoApprovalId).
// Add new entries here to extend the blocklist.
export const BLOCKED_RECIPIENT_DOMAINS: ReadonlySet<string> = new Set([
  'bunq.com',
  'shopify.com',
  'cert.gov.ua',
  'shopifylegal.zendesk.com',
]);

const REPORT_RECIPIENT_RE =
  /\b(report|reports|fraud|abuse|phish|phishing|spoof|legal|security|trust|safety|compliance|complaints?)@/i;

const GROUP_TARGET_RE =
  /\b(merchant[\s-]?trust|trust[\s-]?(and[\s-]?)?safety|fraud[\s-]?team|abuse[\s-]?team)\b/i;

const STRONG_CONTENT: Array<[RegExp, GmailOutboundCategory]> = [
  [/account[\s-]?takeover/i, 'fraud_report'],
  [/\bwe are reporting\b/i, 'fraud_report'],
  [/\breport(ing)?\b[^.\n]{0,40}\b(active\s+)?(account[\s-]?takeover|fraud|abuse|phishing)\b/i, 'fraud_report'],
  [/\b(fraud(ulent)?|unauthorized)\b[^.\n]{0,40}\b(report|notification|claim|charge|payout|access|transaction)\b/i, 'fraud_report'],
  [/\b(an\s+)?attacker\b/i, 'fraud_report'],
  [/\baccount\s+(was\s+)?compromis(e|ed)\b/i, 'fraud_report'],
  [/\bchargeback\b/i, 'chargeback'],
  [/\bdispute (the |this )?(charge|transaction|payment)\b/i, 'chargeback'],
  [/\b(law enforcement|police report|file a (police )?report|FBI|IC3|cybercrime)\b/i, 'law_enforcement'],
  [/\b(cease and desist|legal action|our (lawyers?|counsel)|DMCA takedown|subpoena)\b/i, 'legal_threat'],
];

const WEAK_CONTENT: Array<[RegExp, GmailOutboundCategory]> = [
  [/\bhold\b[^.\n]{0,30}\bpayout\b/i, 'fraud_report'],
  [/\bfreeze\b[^.\n]{0,30}\b(account|funds|payout)\b/i, 'fraud_report'],
  [/\bsuspicious\b[^.\n]{0,30}\b(activity|login|access|change)\b/i, 'fraud_report'],
  [/\babuse (report|complaint)\b/i, 'abuse_report'],
];

function recipients(input: GmailOutboundCheckInput): string[] {
  const raw = [input.to, ...(input.cc ?? [])].join(' ');
  return raw
    .split(/[,;\s]+/)
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.includes('@') || GROUP_TARGET_RE.test(r));
}

function isExternal(addr: string): boolean {
  const at = addr.lastIndexOf('@');
  if (at === -1) return false;
  const domain = addr.slice(at + 1);
  return domain !== INTERNAL_DOMAIN && !domain.endsWith('.' + INTERNAL_DOMAIN);
}

/**
 * Classify an outbound Gmail send. gated === true means it is an external
 * fraud/abuse/legal/chargeback/law-enforcement report and requires an explicit
 * CEO-approved approval ID before the send can proceed.
 */
export function classifyGmailOutbound(input: GmailOutboundCheckInput): GmailOutboundDecision {
  const reasons: string[] = [];
  const haystack = `${input.subject ?? ''}\n${input.text ?? ''}`;
  const rcpts = recipients(input);

  // Absolute domain blocklist — checked before any content-pattern logic.
  // No content bypass; only a CEO board approval can override.
  for (const r of rcpts) {
    const at = r.lastIndexOf('@');
    if (at === -1) continue;
    const domain = r.slice(at + 1);
    if (BLOCKED_RECIPIENT_DOMAINS.has(domain)) {
      return { category: 'blocked_domain', external: true, gated: true, reasons: [`blocked-domain:${domain}`] };
    }
  }

  const external = rcpts.some((r) => isExternal(r));
  const hasReportRecipient = rcpts.some((r) => REPORT_RECIPIENT_RE.test(r));
  const hasGroupTarget = rcpts.some((r) => GROUP_TARGET_RE.test(r));

  let category: GmailOutboundCategory | null = null;

  for (const [re, cat] of STRONG_CONTENT) {
    if (re.test(haystack)) {
      category = category ?? cat;
      reasons.push(`strong-signal:${cat}`);
    }
  }

  if (!category) {
    for (const [re, cat] of WEAK_CONTENT) {
      if (re.test(haystack) && (hasReportRecipient || hasGroupTarget)) {
        category = category ?? cat;
        reasons.push(`weak-signal+report-recipient:${cat}`);
      }
    }
  }

  if (!category && (hasReportRecipient || hasGroupTarget)) {
    category = hasGroupTarget ? 'abuse_report' : 'fraud_report';
    reasons.push(hasGroupTarget ? 'group-target' : 'report-recipient');
  }

  if (hasReportRecipient) reasons.push('recipient:report-desk');
  if (hasGroupTarget) reasons.push('recipient:trust-safety-group');

  const gated = category !== null && (external || hasGroupTarget);

  return { category, external: external || hasGroupTarget, gated, reasons };
}

export class GmailOutboundBlockedError extends Error {
  readonly decision: GmailOutboundDecision;
  constructor(decision: GmailOutboundDecision) {
    const categoryDesc =
      decision.category === 'blocked_domain'
        ? 'send to a blocklisted recipient domain'
        : `outbound ${decision.category}`;
    super(
      `BLOCKED: Gmail ${categoryDesc} to a third party requires explicit CEO approval ` +
        `(AUR-2525 guardrail). Signals: ${decision.reasons.join(', ')}. ` +
        `Obtain board approval via request_board_approval and attach the returned approvalId as ` +
        `ceoApprovalId in the request body.`,
    );
    this.name = 'GmailOutboundBlockedError';
    this.decision = decision;
  }
}
