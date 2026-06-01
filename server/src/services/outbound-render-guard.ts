import { logger } from "../middleware/logger.js";

export class UnresolvedPlaceholderError extends Error {
  readonly tokens: string[];
  constructor(tokens: string[]) {
    super(`Outbound send blocked: unresolved placeholder(s): ${tokens.join(", ")}`);
    this.name = "UnresolvedPlaceholderError";
    this.tokens = tokens;
  }
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[[\w ][\w ]*\]/g,               // [Name], [First Name], [Company]
  /\{\{[\w ]+\}\}/g,                 // {{name}}, {{firstName}}
  /(?<!\{)\{[\w ][\w ]*\}(?!\})/g,  // {name} (not inside {{...}})
  /%[\w ][\w ]*%/g,                  // %name%, %first_name%
  /<[A-Z][A-Za-z ]*>/g,             // <Name>, <First Name> (uppercase-first; avoids html tags)
];

export function findUnresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) found.add(m);
    }
  }
  return [...found];
}

export function assertNoUnresolvedPlaceholders(subject: string, body: string): void {
  const tokens = [...findUnresolvedPlaceholders(subject), ...findUnresolvedPlaceholders(body)];
  if (tokens.length > 0) {
    logger.error({ tokens }, "outbound-render-guard: unresolved placeholder(s) detected — send blocked");
    throw new UnresolvedPlaceholderError(tokens);
  }
}

export function renderGreeting({
  firstName,
  company,
}: {
  firstName?: string | null;
  company?: string | null;
}): string {
  const name = firstName?.trim();
  if (!name) {
    const co = company?.trim();
    return co ? `Hello from ${co}` : "Dear Sir/Madam";
  }
  return `Hi ${name}`;
}
