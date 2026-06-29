# Durable GitHub push credential — GitHub App installation tokens

**Status:** design decided (CTO, AUR-3033) · implementation tracked separately · gated on a one-time human App bootstrap.

## Problem (why this keeps recurring)

Every push/PR cycle authenticates through a hand-pasted GitHub PAT (via the `gh auth git-credential` helper). PATs expire — classic on their TTL, fine-grained at ≤1 year — so the credential periodically goes 401 and **all push/PR work blocks on a human re-auth**. AUR-2826 and AUR-1678 both closed `done` but neither delivered a *durable* credential; the gap re-fired as AUR-2829 and produced 5 tool-gap reports across 4 agents (cluster `github-push-credentials`, weighted frequency 9 — HIGH).

The fallback when the credential is dead — working-tree branch + server restart — works for landing code into the running instance but cannot push to GitHub or open PRs, so it does not close the gap.

## Decision

Use a **GitHub App installation token** as the durable push credential. It is the only option that is simultaneously:

| Property | No-expiry classic PAT | Fine-grained PAT | **GitHub App token** |
|---|---|---|---|
| Durable forever (no recurring human re-auth) | ✅ | ❌ (≤1yr) | ✅ (auto-refresh) |
| Repo-scoped least privilege | ❌ (account-wide) | ✅ | ✅ |
| Agent-rotatable with zero ongoing human action | ⚠️ | ⚠️ | ✅ |
| Short-lived blast radius if leaked | ❌ | ❌ | ✅ (1-hour tokens) |

After a **one-time** human App creation + private-key seed, agents mint fresh 1-hour installation tokens on demand, forever, with no further human involvement. The only failure mode is a human revoking/deleting the App or rotating its key — which fails loud with an exact runbook command.

### How it composes with the secret-vault

The vault (`scripts/secret_vault.py`, host `78.153.195.107`, AUR-2398) is **custody-only by design** — Guardrail 5 says it never mints or refreshes tokens, never calls an OAuth endpoint. We preserve that boundary:

- The vault stores **only** the App's PEM private key (pure custody — a human seeds it once).
- A **separate** tool, `scripts/github_app_token.py`, performs the JWT → installation-token exchange. The minting logic lives outside the vault so the vault stays a dumb encrypted store.

```
human (one time) ──seed PEM──► secret-vault (custody)
                                     │ get
                                     ▼
git push ──helper──► github_app_token.py ──JWT(RS256,10m)──► POST /app/installations/{id}/access_tokens
                                     │                                   │
                                     │◄──────── 1-hour installation token ┘
                                     ▼
                          username=x-access-token / password=<token>  → github.com
```

## Components

1. **One-time human bootstrap** (see runbook below): create a GitHub App owned by the repo owner, grant **Repository permissions → Contents: Read & write** and **Pull requests: Read & write**, install it on the `paperclip` repo, download the `.pem` private key, and record the numeric **App ID** and **Installation ID**.

2. **Seed the private key into the vault** (custody):
   ```bash
   PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py seed github-app-key \
     --scopes contents:write pull_requests:write
   # paste the full PEM (-----BEGIN ... PRIVATE KEY----- ... END-----) at the hidden prompt
   ```
   The App ID and Installation ID are **not secret** — store them in `scripts/github-app.config.json` (gitignored on the host, or committed with placeholders) or via `secret_vault.py put github-app-meta`.

3. **`scripts/github_app_token.py`** (to build) — reads the PEM from the vault, signs a 10-minute RS256 JWT, exchanges it at `POST https://api.github.com/app/installations/{installation_id}/access_tokens` for a ≤1-hour installation token. Caches the token on the host (mode 0600, ~50-min TTL) so back-to-back git ops don't re-mint. Prints the token to stdout (or `--git-credential` to emit the credential-helper protocol).

4. **`scripts/git-credential-github-app.sh`** (to build) — git credential-helper protocol shim. On `get`, calls `github_app_token.py --git-credential` and emits:
   ```
   username=x-access-token
   password=<minted installation token>
   ```
   Wire it: `git config credential.https://github.com.helper '!/home/ievgen/paperclip/scripts/git-credential-github-app.sh'` (replacing the `gh auth git-credential` helper).

5. **Pre-push freshness check** (to build) — a `pre-push` hook (or `git pc-push` wrapper) that mints a token *before* the push. On mint failure (key revoked/rotated/App uninstalled) it aborts loud with the exact rotation command rather than letting git emit an opaque 401.

## Rotation runbook

If the App private key is rotated or the token mint starts failing:

1. In GitHub → the App's settings → **Private keys** → *Generate a new private key* (download `.pem`).
2. Re-seed: `PAPERCLIP_AGENT_ID=<id> python3 scripts/secret_vault.py seed github-app-key --scopes contents:write pull_requests:write` (paste the new PEM).
3. Delete the host token cache so the next git op re-mints: `rm -f /home/ievgen/secret-vault/.github-app-token-cache`.

No code change, no PR, no redeploy — rotation is a single re-seed. This is what makes the credential *agent-rotatable* end-to-end after the initial human App creation.

## Fallback (unchanged)

If the durable credential is ever fully down, landing code into the running instance still works via the working-tree-branch + server-restart path (no GitHub round-trip). It cannot open PRs, so it is a stopgap, not a substitute.
