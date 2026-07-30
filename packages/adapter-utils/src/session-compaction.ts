export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
}

export type NativeContextManagement = "confirmed" | "likely" | "unknown" | "none";

export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: NativeContextManagement;
  defaultSessionCompaction: SessionCompactionPolicy;
}

export interface ResolvedSessionCompactionPolicy {
  policy: SessionCompactionPolicy;
  adapterSessionManagement: AdapterSessionManagement | null;
  explicitOverride: Partial<SessionCompactionPolicy>;
  source: "adapter_default" | "agent_override" | "legacy_fallback";
}

const DEFAULT_SESSION_COMPACTION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 200,
  maxRawInputTokens: 2_000_000,
  maxSessionAgeHours: 72,
};

// Adapters with native context management still participate in session resume,
// but Paperclip should not rotate them using threshold-based compaction.
const ADAPTER_MANAGED_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
};

// claude_local pins the standard 200K context window (the Claude Code CLI is
// prevented from auto-upgrading resumed sessions to the paid 1M-context beta;
// see CLAUDE_CODE_DISABLE_1M_CONTEXT in the claude-local adapter). Because the
// session can no longer silently grow past 200K, we MUST rotate it before the
// raw input crosses that boundary — otherwise the resumed run would hit the
// hard "prompt too long" wall instead. 150K leaves ~50K of headroom for the
// next turn's input growth plus output, well under the 200K limit. This is the
// safety net for (and complements) the CLI-side 1M lock: even if a future CLI
// version changes its auto-upgrade behaviour, Paperclip rotates first.
// AUR-4513 recalibration. The values above were dead in practice: measured over the
// 39 sessions that ever overflowed, the empirical onset of `Prompt is too long` was
//
//   metric                            | min  | p05  | median | max
//   session depth (runs) at overflow   |   16 |   40 |     66 |  129
//   session age (hours) at overflow    | 13.0 | 20.2 |   34.9 | 70.8
//
// `maxSessionRuns: 200` sits ABOVE the observed max of 129, so it could never fire
// before the wall; `maxSessionAgeHours: 72` misses the max observed onset of 70.8h by
// 1.2h. Both are now set strictly below the observed MINIMUM, not the median, because
// the minimum is the only value that protects every session rather than half of them:
//   - 12 runs => 25% headroom under the 16-run minimum
//   - 8 hours => 38% headroom under the 13.0h minimum
// `maxRawInputTokens: 150_000` is retained but is not load-bearing for claude_local:
// rawInputTokens is a per-turn uncached delta (fleet max 6,579) and never tracks
// resumed-session context, so this threshold has fired twice ever, both times on the
// generic 2M default. The run/age pair is what actually protects the session.
const CLAUDE_LOCAL_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 12,
  maxRawInputTokens: 150_000,
  maxSessionAgeHours: 8,
};

/**
 * AUR-4513: error code for a deterministic prompt-size rejection.
 *
 * Lives here rather than in the claude-local adapter because both the adapter (which
 * emits it) and the heartbeat service (which forces session rotation on it) need it,
 * and importing the adapter's server entry into the service would pull in its whole
 * child_process module graph.
 */
export const CLAUDE_CONTEXT_OVERFLOW_ERROR_CODE = "claude_context_overflow";

/**
 * Wording that identifies a prompt-size rejection. Kept as a source string so the
 * substring and anchored forms below can never drift apart.
 */
const CLAUDE_CONTEXT_OVERFLOW_PATTERN =
  "(?:prompt\\s+is\\s+too\\s+long" +
  "|input\\s+length\\s+and\\s+`?max_tokens`?\\s+exceed\\s+context\\s+limit" +
  "|context\\s+(?:length|window)\\s+(?:limit\\s+)?exceeded" +
  "|exceeds?\\s+(?:the\\s+)?maximum\\s+context\\s+length" +
  "|too\\s+many\\s+total\\s+text\\s+bytes)";

/** Substring form. ONLY safe on text the model cannot author. */
export const CLAUDE_CONTEXT_OVERFLOW_RE = new RegExp(CLAUDE_CONTEXT_OVERFLOW_PATTERN, "i");

/**
 * Anchored form. The phrase must OPEN the payload and be followed by end-of-string
 * or punctuation, so it matches a failure *value* but not the same words used inside
 * a sentence.
 *
 *   "Prompt is too long"                                    -> match
 *   "input length and `max_tokens` exceed context limit: …" -> match
 *   "…fails because the prompt is too long, so I …"         -> NO match (mid-sentence)
 *   "Prompt is too long fix landed"                         -> NO match (prose)
 */
const CLAUDE_CONTEXT_OVERFLOW_ANCHORED_RE = new RegExp(
  `^(?:${CLAUDE_CONTEXT_OVERFLOW_PATTERN})(?=\\s*(?:$|[:.,;!?]))`,
  "i",
);

/**
 * `describeClaudeFailure` wraps the detail as `Claude run failed: subtype=<x>: <detail>`,
 * and the no-parse path wraps stderr as `Claude exited with code <n>: <detail>`. Strip
 * either wrapper so the anchored test sees the payload itself.
 */
const CLAUDE_FAILURE_WRAPPER_RE =
  /^(?:claude\s+run\s+failed(?::\s*subtype=[^:\s]*)?|claude\s+exited\s+with\s+code\s+-?\d+):\s*/i;

/**
 * AUR-4557: true only when `value` *is* an overflow failure message, not when it
 * merely mentions one.
 *
 * AUR-4513 shipped a classifier that excluded `stdout`/`stderr` but still read
 * `parsed.result` — which IS the model's final assistant message — and `errorMessage`,
 * which folds `parsed.result` in. That reproduced the very transcript-contamination
 * bug it was written to fix: an agent that summarised "…the prompt is too long…" and
 * then failed for an unrelated reason (or on a real 529) was coded as a deterministic
 * overflow, losing its retry ladder and force-rotating its session.
 */
export function isClaudeContextOverflowMessage(value: string | null | undefined): boolean {
  if (!value) return false;
  const payload = value.trim().replace(CLAUDE_FAILURE_WRAPPER_RE, "").trim();
  if (!payload) return false;
  return CLAUDE_CONTEXT_OVERFLOW_ANCHORED_RE.test(payload);
}

export const LEGACY_SESSIONED_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

export const ADAPTER_SESSION_MANAGEMENT: Record<string, AdapterSessionManagement> = {
  acpx_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  claude_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: CLAUDE_LOCAL_SESSION_POLICY,
  },
  codex_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  cursor_cloud: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  cursor: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  gemini_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  opencode_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  pi_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  hermes_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

export function getAdapterSessionManagement(adapterType: string | null | undefined): AdapterSessionManagement | null {
  if (!adapterType) return null;
  return ADAPTER_SESSION_MANAGEMENT[adapterType] ?? null;
}

export function readSessionCompactionOverride(runtimeConfig: unknown): Partial<SessionCompactionPolicy> {
  const runtime = isRecord(runtimeConfig) ? runtimeConfig : {};
  const heartbeat = isRecord(runtime.heartbeat) ? runtime.heartbeat : {};
  const compaction = isRecord(
    heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction,
  )
    ? (heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction) as Record<string, unknown>
    : {};

  const explicit: Partial<SessionCompactionPolicy> = {};
  const enabled = readBoolean(compaction.enabled);
  const maxSessionRuns = readNumber(compaction.maxSessionRuns);
  const maxRawInputTokens = readNumber(compaction.maxRawInputTokens);
  const maxSessionAgeHours = readNumber(compaction.maxSessionAgeHours);

  if (enabled !== undefined) explicit.enabled = enabled;
  if (maxSessionRuns !== undefined) explicit.maxSessionRuns = maxSessionRuns;
  if (maxRawInputTokens !== undefined) explicit.maxRawInputTokens = maxRawInputTokens;
  if (maxSessionAgeHours !== undefined) explicit.maxSessionAgeHours = maxSessionAgeHours;

  return explicit;
}

export function resolveSessionCompactionPolicy(
  adapterType: string | null | undefined,
  runtimeConfig: unknown,
): ResolvedSessionCompactionPolicy {
  const adapterSessionManagement = getAdapterSessionManagement(adapterType);
  const explicitOverride = readSessionCompactionOverride(runtimeConfig);
  const hasExplicitOverride = Object.keys(explicitOverride).length > 0;
  const fallbackEnabled = Boolean(adapterType && LEGACY_SESSIONED_ADAPTER_TYPES.has(adapterType));
  const basePolicy = adapterSessionManagement?.defaultSessionCompaction ?? {
    ...DEFAULT_SESSION_COMPACTION_POLICY,
    enabled: fallbackEnabled,
  };

  return {
    policy: {
      enabled: explicitOverride.enabled ?? basePolicy.enabled,
      maxSessionRuns: explicitOverride.maxSessionRuns ?? basePolicy.maxSessionRuns,
      maxRawInputTokens: explicitOverride.maxRawInputTokens ?? basePolicy.maxRawInputTokens,
      maxSessionAgeHours: explicitOverride.maxSessionAgeHours ?? basePolicy.maxSessionAgeHours,
    },
    adapterSessionManagement,
    explicitOverride,
    source: hasExplicitOverride
      ? "agent_override"
      : adapterSessionManagement
        ? "adapter_default"
        : "legacy_fallback",
  };
}

export function hasSessionCompactionThresholds(policy: Pick<
  SessionCompactionPolicy,
  "maxSessionRuns" | "maxRawInputTokens" | "maxSessionAgeHours"
>) {
  return policy.maxSessionRuns > 0 || policy.maxRawInputTokens > 0 || policy.maxSessionAgeHours > 0;
}
