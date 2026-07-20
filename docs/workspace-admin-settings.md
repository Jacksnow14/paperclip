# Google Workspace Admin AI Settings — programmatic read/toggle

**Status:** recipe documented; live use is **board-gated** (see [Credential & board gate](#credential--board-gate)).
**Domain:** `tryauranode.com` (Workspace)
**Source gap:** AUR-3726 (recurring tool-gap cluster). Unblocks AUR-3640's mechanics.

This doc answers the recurring question: *"how does an agent read or flip a Google
Workspace Admin Console AI feature setting (Gemini app / My Avatar, Google Pics, Vids
personal avatars) non-interactively?"*

---

## TL;DR — which path

| Path | Verdict |
|---|---|
| **Admin SDK / any Google API** | ❌ **No API surface exists** for these settings. Do not spend tokens chasing it. |
| **browser-bridge vs. `admin.google.com`** | ✅ Only reusable path. Requires a seeded **super-admin** browser profile — **board-gated (Phase 2, AUR-2398).** |

**Bottom line:** the mechanics below are ready. The one thing an agent cannot self-serve
is the super-admin session credential. That seeding is a human/board action.

---

## Why there is no Admin SDK path (do not re-investigate this)

The Google Admin SDK and adjacent APIs do **not** expose the Generative-AI / Gemini
feature toggles that agents keep needing:

- **Admin SDK Directory API** (`admin.googleapis.com/admin/directory/v1`) — manages
  users, groups, org units, devices, roles, domains, and role assignments. It has **no
  endpoint** for per-service feature toggles, and no generic "turn service X on/off for
  this OU" call. The Gemini app / My Avatar / Google Pics / Vids-avatar switches are not
  represented anywhere in Directory API.
- **Chrome Policy API** (`chromepolicy.googleapis.com`) — manages Chrome browser/device
  *policies*, not Workspace-app AI settings. The Admin-console "Generative AI" and
  per-app service settings are not Chrome policies.
- **Cloud Identity API** — org units and groups membership; again, no feature toggles.

Google surfaces these AI settings **only in the Admin console UI**, under *Generative AI*
and the individual additional-service settings pages. There is no published API, so
adding Admin scopes to the existing Gmail DWD service account
(`paperclip-mail@paperclip-497312.iam.gserviceaccount.com`) would reach nothing for these
settings. That is the root of the recurring gap.

> If Google later ships a Generative-AI settings API, revisit this. As of 2026-07 there is
> none.

---

## The reusable path: browser-bridge against admin.google.com

Because the only surface is the Admin console UI, the reusable path is
[`scripts/browser_bridge.py`](browser-bridge.md) (Playwright + persistent Chromium
profile on host `78.153.195.107`) driving `admin.google.com` with a seeded **super-admin**
profile.

Profile name (proposed): **`gworkspace-admin`** at
`/home/ievgen/browser-profiles/gworkspace-admin/`. It must be logged in as a
`tryauranode.com` **super administrator** (a delegated admin with only the relevant
service-settings privilege is sufficient and preferred — least privilege).

### Settings agents have needed (Admin console navigation)

| Setting | Admin console path |
|---|---|
| Gemini app (on/off) | Apps → Google Workspace → **Gemini** → *Service status* |
| **My Avatar in Gemini** | Apps → Google Workspace → **Gemini** → *Generative AI* / feature settings → My Avatar |
| Google Pics (personal avatars) | Apps → Additional Google services → **Google Pics** → service settings |
| Google Vids — personal avatars | Apps → Google Workspace → **Google Vids** → *Personal avatars* |

> The Admin console is a dynamic SPA; the stable `admin.google.com/ac/...` deep link and
> the exact toggle selector for each setting must be captured during the first seeded
> session and recorded back into this table (see [Hardening](#hardening)).

### Read a setting (state check)

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "read_page",
  "url": "https://admin.google.com/ac/apps/gemini",
  "profile": "gworkspace-admin",
  "timeout_ms": 45000,
  "max_text_chars": 16000
}'
```

Inspect `data.page_text` (and a `screenshot` command for visual confirmation) to read the
current on/off state of the target toggle.

### Toggle a setting (write) — verify → flip → re-verify

1. **Verify current state** with `read_page` / `screenshot` (above).
2. **Flip** with `fill_and_submit` (or `run_js` clicking the control), using the selector
   captured during hardening:

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "fill_and_submit",
  "url": "https://admin.google.com/ac/apps/gemini",
  "profile": "gworkspace-admin",
  "fields": [{"selector": "<captured toggle selector>", "value": "on", "action": "check"}],
  "submit_selector": "<captured save selector>",
  "timeout_ms": 45000
}'
```

3. **Re-verify** with another `read_page`/`screenshot` and confirm the new state.
   Save the screenshot as evidence (`evidence_dir`).

This "read → change → read-back" loop is the acceptance test: an agent confirms the flip
without a human in the loop, once the profile is seeded.

---

## Credential & board gate

- **What's needed:** a persistent Chromium profile logged in as a `tryauranode.com`
  super-admin (or a least-privilege delegated admin with the service-settings role).
- **Why an agent can't self-serve it:** seeding requires a human super-admin login +
  2FA, and the browser-bridge security boundary **explicitly defers admin-write profiles
  to board-gated Phase 2** ([browser-bridge.md § Security boundary](browser-bridge.md),
  AUR-2398): *"Do NOT seed admin-write profiles (Google Workspace Admin delegated
  write...)."*
- **Vault record:** once approved, log the seeded profile in the vault for audit/revocation:
  `python3 scripts/secret_vault.py put google_workspace_admin --scopes admin.console.readwrite`
  (the value is a pointer/note; the live session lives in the profile dir, never in git).

### Unblock steps (owner: board + operator)

1. **Board:** lift the Phase-2 admin-write gate for a `gworkspace-admin` browser profile
   (read-only first is acceptable to satisfy the read half immediately; write requires the
   full gate).
2. **Operator:** seed the profile once via VNC on `78.153.195.107`
   (`DISPLAY=:1 chromium-browser --user-data-dir=/home/ievgen/browser-profiles/gworkspace-admin https://admin.google.com`),
   complete super-admin login + 2FA, close the browser (cookies persist).
3. **Agent:** run the read/toggle recipe above; capture concrete deep-links + selectors
   and harden this doc.

---

## Hardening (first live run)

The recipe is written against menu breadcrumbs because selectors can't be known before the
first seeded session. On the first successful live run, capture and commit back:

- The stable `admin.google.com/ac/...` deep link for each setting.
- The exact toggle + save-button selectors (or a `run_js` snippet that flips the control).
- A screenshot per setting in the evidence dir as a known-good baseline.

Until then, treat the toggle step as "navigate + screenshot + click by visible label",
which is slower but functional under the seeded profile.
