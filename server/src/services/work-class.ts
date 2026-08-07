// AUR-5168: classify issues as 'revenue' or 'self_improvement' work so the
// weekly self-improvement budget cap has something to enforce against.
// Deliberately not a taxonomy: 4 ordered rules, default always resolves.

export type WorkClass = "revenue" | "self_improvement";

// The company's own tooling/runtime project. Everything else defaults to
// revenue so the cap can never silently starve product work.
export const SELF_IMPROVEMENT_PROJECT_ID = "593af91d-6e65-47fe-9db2-cd39469548f8";

// Named revenue projects, documented explicitly per AUR-5168 AC1 even though
// 'revenue' is also the fallback — pins them against the paperclip-repo
// heuristic below in case their workspace ever shares that repo.
const PROJECT_WORK_CLASS: Record<string, WorkClass> = {
  [SELF_IMPROVEMENT_PROJECT_ID]: "self_improvement",
  "1ed2097c-fe42-46b1-9b04-8c20955a8876": "revenue", // Etsy Storefront
  "99883424-9aa3-434b-8a3e-1ee96dddfdf3": "revenue", // Shopify Storefront
  "91d46af0-db3c-4bf5-874a-1d3abd2a5e07": "revenue", // Auranode Deliverability Routine Host
  "ff854c63-3334-44f3-88ad-906ede830c80": "revenue", // Auranode Routine Host
  "f891ad71-30fb-4b88-a880-7951f3ef27f2": "revenue", // Voice Front Desk Pilot (outreach)
};

const EXEC_WORK_CLASS_PATTERN = /exec\.work_class:\s*(revenue|self_improvement)\b/i;

function extractExplicitWorkClass(description: string | null | undefined): WorkClass | null {
  if (!description) return null;
  const match = description.match(EXEC_WORK_CLASS_PATTERN);
  if (!match) return null;
  return match[1].toLowerCase() as WorkClass;
}

function repoUrlIsPaperclip(repoUrl: string | null | undefined): boolean {
  if (!repoUrl) return false;
  return repoUrl.toLowerCase().includes("/paperclip");
}

export interface DeriveWorkClassInput {
  description?: string | null;
  projectId?: string | null;
  workspaceRepoUrl?: string | null;
}

/**
 * Derivation order (AUR-5168 AC1): explicit token > projectId map >
 * paperclip-repo heuristic > default revenue.
 */
export function deriveWorkClass(input: DeriveWorkClassInput): WorkClass {
  const explicit = extractExplicitWorkClass(input.description);
  if (explicit) return explicit;

  if (input.projectId) {
    const mapped = PROJECT_WORK_CLASS[input.projectId];
    if (mapped) return mapped;
  }

  if (repoUrlIsPaperclip(input.workspaceRepoUrl)) {
    return "self_improvement";
  }

  return "revenue";
}
