# Secret Vault — Phase 2a Foundation

Encrypted, audited, revocable credential storage for OAuth tokens and API secrets used by Paperclip agents. Pairs with the Phase 1 browser-bridge (`scripts/browser_bridge.py`) which handles no-secret interactive sessions.

Host: predictor/CTO host `78.153.195.107`.  
Vault directory: `/home/ievgen/secret-vault/` (outside the repo, never committed).

---

## Architecture

```
/home/ievgen/secret-vault/
├── vault.key          # Fernet symmetric key (AES-128-CBC + HMAC-SHA256) — mode 0600
├── secrets.json.enc   # Fernet-encrypted JSON blob of all records — mode 0600
└── vault-audit.log    # Append-only plain-text audit trail
```

The vault directory itself is mode 0700. The repo's `.gitignore` ignores `secret-vault/`, `vault.key`, `secrets.json.enc`, and `vault-audit.log` — none of these files can accidentally be committed.

**Encryption:** `cryptography.fernet.Fernet` — 128-bit AES-CBC with PKCS7 padding, authenticated with HMAC-SHA256. The key is generated once on first use and stored at `vault.key` on the host. It is never committed to git, never logged, and never transmitted.

---

## Board Guardrails — Implementation Map

| Guardrail | How it is met |
|-----------|--------------|
| **1. Encrypted at rest + host-only, never in git** | Fernet key at `/home/ievgen/secret-vault/vault.key`; ciphertext at `secrets.json.enc`. Both paths are outside the repo and `.gitignore`d. Verified: `hexdump` of the at-rest file shows only base64 ciphertext; `grep` for any plaintext token returns 0 matches. |
| **2. Per-service least-scope tokens** | `put` and `seed` require `--scopes` (argparse `required=True`); omitting it exits non-zero before any vault write occurs. |
| **3. Access/audit log of every vault use** | `_audit()` appends `timestamp  agent=<id>  service=<svc>  action=<op>` to `vault-audit.log` on every `put`, `get`, `list`, `revoke`. |
| **4. Documented revocation path** | `revoke` deletes the local ciphertext record and logs the event. It also prints a mandatory upstream reminder. See § Revocation below. |
| **5. Human-seeded consent per service** | `seed` uses `getpass.getpass()` — interactive, value never appears in shell history or logs. The vault has no token-refresh or OAuth dance. Only a human can introduce a new secret. |

---

## Commands

```bash
# Interactive consent seed (human pastes token; hidden from shell history/logs)
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py seed <service> --scopes <scope1> [<scope2> ...]

# Non-interactive put (automation; still requires --scopes)
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py put <service> --scopes <scope1> [<scope2> ...] --value <secret>

# Retrieve
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py get <service>

# List all services (no secret values shown)
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py list

# Revoke (see § Revocation below)
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py revoke <service>

# Audit log (last 20 lines by default)
PAPERCLIP_AGENT_ID=<agent-id> python3 scripts/secret_vault.py audit [--tail N]
```

Set `PAPERCLIP_AGENT_ID` to the Paperclip agent UUID so every audit entry is attributed.

---

## Seed Consent Flow

Only a human or CTO seeds a service. The flow:

1. Obtain the token/secret from the provider console (Google Cloud, Shopify, etc.) with the minimum required scopes.
2. On the predictor host, run:
   ```bash
   PAPERCLIP_AGENT_ID=cto python3 scripts/secret_vault.py seed google-workspace \
     --scopes https://www.googleapis.com/auth/admin.directory.user.readonly
   ```
3. Paste the token at the prompt (input is hidden).
4. Verify the entry: `python3 scripts/secret_vault.py get google-workspace`.
5. Verify the audit entry: `python3 scripts/secret_vault.py audit --tail 5`.

**The vault never calls any OAuth endpoint. It stores only what you explicitly seed.**

---

## Revocation

Revoking a leaked or expired token requires **two steps**:

### Step 1 — Remove the local copy
```bash
PAPERCLIP_AGENT_ID=cto python3 scripts/secret_vault.py revoke <service>
```
This deletes the local ciphertext record and appends a `revoke` entry to the audit log. After this, `get <service>` returns an error.

### Step 2 — Revoke upstream in the provider console
The local deletion does **not** invalidate the token with the provider. You must also:

| Provider | Where to revoke |
|----------|----------------|
| Google Workspace | [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) → delete the OAuth client or revoke the token |
| Shopify | Shopify Partners → Apps → your app → API access → revoke |
| YouTube / Google OAuth | Same as Google above, or call `POST https://oauth2.googleapis.com/revoke?token=<token>` |
| Generic | Use the provider's token revocation endpoint or admin console |

Only after both steps is the token fully dead.

---

## Files and gitignore

The following patterns are in `.gitignore` (verified via `git check-ignore`):

```
secret-vault/
vault.key
secrets.json.enc
vault-audit.log
```

The vault directory `/home/ievgen/secret-vault/` is outside the repository root (`/home/ievgen/paperclip`) and therefore cannot be tracked by git regardless of gitignore.

---

## Out of scope (Phase 2a)

- No MCP tool wiring yet — CLI + doc is the reviewable first slice (Phase 2b).
- No real Google Workspace / YouTube / Shopify admin tokens — per-service seeding is separate demand-driven work filed after CTO reviews this foundation.
- No token refresh — the vault is a custody mechanism, not an OAuth client.
