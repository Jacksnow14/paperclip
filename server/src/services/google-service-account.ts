// Shared GOOGLE_WORKSPACE_SA_KEY loader for services that impersonate a
// tryauranode.com mailbox via domain-wide delegation (Gmail, Workspace
// Directory/Licensing APIs). Extracted from gmail.ts (AUR-3298) so new
// Workspace integrations don't re-implement the same PEM validation.
export function loadServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_WORKSPACE_SA_KEY;
  if (!raw) {
    throw new Error("GOOGLE_WORKSPACE_SA_KEY is not configured");
  }
  let key: Record<string, string>;
  try {
    key = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("GOOGLE_WORKSPACE_SA_KEY is not valid JSON");
  }
  // Fail fast: systemd EnvironmentFile strips backslashes from unquoted values,
  // turning \n → n and breaking PEM parsing with a cryptic OpenSSL DECODER error.
  // Fix: single-quote the value in EnvironmentFile so systemd leaves it verbatim.
  const pk = key["private_key"] ?? "";
  if (!pk.startsWith("-----BEGIN") || !pk.includes("\n")) {
    throw new Error(
      "GOOGLE_WORKSPACE_SA_KEY private_key is malformed (missing PEM header or newlines). " +
        "Ensure the value is single-quoted in EnvironmentFile to prevent systemd backslash stripping.",
    );
  }
  return key;
}
