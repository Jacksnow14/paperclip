# GitHub Push Credentials — Vault-Backed, Agent-Rotatable

Solves the AUR-3528 tool gap: `git push` / PR creation must never depend on a
founder re-running `gh auth login`. The GitHub token now lives in the
Paperclip secret vault (`docs/secret-vault.md`) and is served to git through
a credential helper, with a REST-based PR creation path that doesn't depend
on the (very old, `v2.4.0` / 2022) local `gh` CLI.

Host: `78.153.195.107` (`ievgen`). Account: `Jacksnow14`, non-expiring classic
PAT (`repo`, `workflow`, ... scopes), installed by AUR-2826.

---

## Architecture

```
                      ┌─────────────────────────────┐
                      │ /home/ievgen/secret-vault/   │
                      │  vault.key + secrets.json.enc│  ← Fernet-encrypted,
                      │  (service: github_push_token)│    outside any repo
                      └───────────────┬──────────────┘
                                      │ read (get)
                                      ▼
        ┌─────────────────────────────────────────────────────┐
        │ /home/ievgen/.paperclip-git-helper/                  │
        │   secret_vault.py            (vault client, copy)    │
        │   git-credential-paperclip   (git credential helper) │
        └───────┬───────────────────────────┬─────────────────┘
                │ credential.helper           │ used by
                ▼                              ▼
   git push / git ls-remote          scripts/gh-pr-create.sh
   (via ~/.gitconfig                 (REST POST .../pulls,
    credential.https://              gh pr create tried first)
    github.com.helper)
```

**Why a copy outside the repo (`/home/ievgen/.paperclip-git-helper/`) instead
of pointing git config straight at `scripts/git-credential-paperclip` in this
working tree:** this repo clone is shared across many concurrent agent
sessions that check out different branches/worktrees constantly. A global
git config entry pointing at a path inside a branch-churning working tree
can vanish out from under `git` mid-task (observed directly while building
this feature — a concurrent checkout wiped the untracked script before it
was committed). The deployed copy under `$HOME` is immune to any branch
switch, `git clean`, or `git reset --hard` run in any clone or worktree.
The copy under `scripts/` in this repo is the reviewed, canonical source;
redeploy after changing it (see **Updating the deployed copy** below).

---

## Files

| Path | Purpose |
|---|---|
| `scripts/secret_vault.py` | Vault client (`get`/`put`/`seed`/`list`/`revoke`/`audit`). Restored from `52f6e357`. |
| `scripts/git-credential-paperclip` | Git credential helper (protocol: `get`/`store`/`erase`). Reads `github_push_token` from the vault. |
| `scripts/gh-pr-create.sh` | Version-independent PR creation: tries `gh pr create`, falls back to REST `POST /repos/{owner}/{repo}/pulls` using the vault token. Idempotent — returns the existing PR URL if one is already open for the branch. |
| `/home/ievgen/.paperclip-git-helper/` | Deployed (non-repo) copies of `secret_vault.py` + `git-credential-paperclip`, referenced by the global git config. |
| `/home/ievgen/secret-vault/` | The vault itself (Fernet key + encrypted secrets + audit log). Never in git. |

---

## Git config (already wired)

```
[credential "https://github.com"]
	helper = /home/ievgen/.paperclip-git-helper/git-credential-paperclip
	helper = store
```

For a `get` request, git tries helpers **in this order** and stops at the
first one that returns a full `username`+`password`:

1. **`git-credential-paperclip`** — vault lookup. On success, emits
   `username=Jacksnow14` + `password=<token>`.
2. **`store`** (`~/.git-credentials`, plaintext) — fallback only. Still
   populated from the original AUR-2826 install, so a vault outage does not
   block pushes.

Our helper's `store`/`erase` operations are no-ops (see script docstring) —
the vault is the single source of truth and is never mutated by git itself.

**Fail-safe contract:** if the vault key/file is missing, unreadable, or has
no `github_push_token` record, `git-credential-paperclip` exits `0` with
**no stdout output**. Git then falls through to `store` rather than failing
the push. It never hard-fails a push due to a vault problem.

---

## Rotation runbook (no founder action required)

Any agent with vault access on this host can rotate the token:

```bash
# 1. Obtain the new classic PAT value some other way (it is NOT minted by
#    this tooling — see "Founder escape hatch" below for when a human is
#    actually needed).

# 2. Store it in the vault (overwrites the existing github_push_token record):
python3 /home/ievgen/.paperclip-git-helper/secret_vault.py put github_push_token \
  --scopes repo workflow --value "$NEW_TOKEN"

# 3. No git reconfiguration needed. Next git operation reads the new value
#    automatically via the credential helper. Verify:
git ls-remote origin HEAD
```

Never pass the token as a bare shell argument if you can avoid it in a
transcript/log; prefer piping it in via a variable populated by a
non-echoing read.

To also purge the stale plaintext fallback after rotating (optional,
tightens the blast radius of the fallback path):

```bash
git credential-store --file ~/.git-credentials erase <<'EOF'
protocol=https
host=github.com

EOF
```

(Leaving the old fallback in place does no harm as long as the old token is
still valid; once the old token is revoked upstream, `store` will simply
fail silently and git moves on — there is no third helper to fall to, so at
that point the vault entry is load-bearing.)

---

## Updating the deployed copy

`scripts/secret_vault.py` and `scripts/git-credential-paperclip` in this repo
are the reviewed source. After merging a change to either, redeploy:

```bash
cp scripts/secret_vault.py scripts/git-credential-paperclip /home/ievgen/.paperclip-git-helper/
chmod 0755 /home/ievgen/.paperclip-git-helper/secret_vault.py /home/ievgen/.paperclip-git-helper/git-credential-paperclip
```

---

## PR creation (`scripts/gh-pr-create.sh`)

```bash
scripts/gh-pr-create.sh --base master --head my-branch --title "..." --body "..."
```

Order of attempts:

1. `gh pr create` (fast path; still works fine for the common case despite
   the CLI being from 2022).
2. If `gh` is missing, fails, or errors for any reason other than "a PR
   already exists" → REST `POST /repos/{owner}/{repo}/pulls` using the vault
   token. Owner/repo are parsed from `git config remote.origin.url` unless
   `--repo owner/name` is passed explicitly.
3. If either path reports "a pull request already exists" for the branch,
   the script looks up and prints the **existing** PR's URL and exits `0` —
   it never treats "PR already open" as a failure.

The token is read once into a shell variable via `secret_vault.py`'s
internal Python API (never passed as a bare CLI arg, never echoed) and used
only for the `Authorization` header.

---

## Fallback order summary

| Layer | Mechanism | Fails when |
|---|---|---|
| 1 | Vault-backed credential helper / vault token in REST calls | Vault key/file missing or corrupted |
| 2 | `store` plaintext fallback (`~/.git-credentials`) | That specific token is revoked/expired |
| 3 (push path) / N/A (PR path) | — | Both layers exhausted |

There is deliberately **no automatic path 3** — see the founder escape hatch
below, which is the only scenario requiring a human, and only if the token
is fully revoked upstream with the vault also empty.

---

## Founder escape hatch (the one residual human-required case)

If the GitHub token is **fully revoked** upstream (e.g. GitHub security
action, org policy change, or manual revocation) **and** no agent has a
valid replacement to seed, a human founder must:

1. Mint a new **classic PAT** on `github.com/settings/tokens` for
   `Jacksnow14` with `repo` + `workflow` scopes, **No expiration**.
2. Hand it to any agent with vault access.
3. That agent runs the rotation runbook above (`secret_vault.py put
   github_push_token ...`) — no further founder involvement, no git
   reconfiguration.

This is the only "blocks all push/PR until a human acts" scenario, and it
only triggers on full upstream revocation with an empty vault — not on
routine rotation, not on `gh` CLI quirks, not on vault-service hiccups (the
`store` fallback absorbs those).
