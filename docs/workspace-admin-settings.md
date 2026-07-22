# Google Workspace Admin AI Settings — programmatic read/toggle

**Status:** recipe **verified live 2026-07-22** (AUR-3769) — admin console reached,
read + real deep-links + selectors captured (below). The **non-interactive headless**
read/flip still needs the host profile seeded (see [Unblock steps](#unblock-steps-owner-board--operator)).
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

### Settings agents have needed — real deep-links (captured live 2026-07-22, AUR-3769)

Domain `tryauranode.com`, super-admin `board@tryauranode.com`.
Left-nav path: **Генеративный искусственный интеллект / Generative AI** → the entries
below. Each service page is `admin.google.com/ac/managedsettings/<serviceId>`; append
`/{SECTION}` to deep-link a specific sub-panel. **Normalize the URL by dropping any
`/u/<N>/` account-index prefix** (it is per-login, e.g. `/u/2/`) — Google resolves the
active account. Deep-links below are already normalized.

| Setting | Real deep-link | Service / section id |
|---|---|---|
| **Gemini app** — *Service status* (safe read) | `/ac/managedsettings/47208553126` | serviceId `47208553126` |
| **My Avatar in Gemini** ("Аватар в Gemini") | `/ac/managedsettings/47208553126/AI_LIKENESS_SETTINGS` | section `AI_LIKENESS_SETTINGS` |
| Gemini — Sharing (chat access, Gem-bots) | `/ac/managedsettings/47208553126/SHARING_SETTINGS` | section `SHARING_SETTINGS` |
| Gemini for Workspace | `/ac/managedsettings/793154499678` | serviceId `793154499678` |
| Gemini Enterprise | `/ac/managedsettings/308858798364` | serviceId `308858798364` |
| NotebookLM | `/ac/managedsettings/692380834322` | serviceId `692380834322` |

> Settings are applied at the **OU** level — org unit **Auranode e.U.** (with sub-OU
> **Workspace Guests**). Confirm the OU selector in the left rail of the edit page targets
> the intended OU before saving.

> **Correction:** the old breadcrumbs "Apps → Google Workspace → Gemini" and the
> placeholder `/ac/apps/gemini` are **wrong** — `/ac/apps/gemini` returns a Google 404.
> Gemini settings live under **Generative AI**, not Apps → Google Workspace, and My Avatar
> is a section *inside* the Gemini app page (not a separate app), reached by expanding
> **"Аватар в Gemini"** which navigates to the `.../AI_LIKENESS_SETTINGS` deep-link above.
> Google Pics / Google Vids deep-links are not yet captured (no live gap for them yet).

### Read a setting (state check)

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "read_page",
  "url": "https://admin.google.com/ac/managedsettings/47208553126",
  "profile": "gworkspace-admin",
  "timeout_ms": 45000,
  "max_text_chars": 16000
}'
```

Inspect `data.page_text` (and a `screenshot` command for visual confirmation) to read the
current state. The Gemini app page renders **all** its settings inline, so one `read_page`
yields both:
- **Service status** → text `Статус сервиса … Включено для всех` (EN: *Service status …
  ON for everyone*). Baseline captured 2026-07-22: **ON for everyone**.
- **My Avatar** → text `Аватар … Выключено: 'Включить аватар в Gemini'` (EN: *Avatar …
  OFF: 'Enable avatar in Gemini'*). Baseline captured 2026-07-22: **OFF** (checkbox
  `checked=false`), applied at OU `Auranode e.U.` — this is the **AUR-3640-compliant**
  state (see note below).

### Toggle a setting (write) — verify → flip → re-verify

The My Avatar control is a **checkbox** (not a switch), so the toggle + save selectors are:

| Element | Selector (captured live 2026-07-22) | Notes |
|---|---|---|
| Toggle | `input[type=checkbox][aria-label="Включить аватар в Gemini"]` | `aria-label` is locale-dependent (this profile is RU). Locale-stable fallback: the single `form input[type=checkbox]` on the `/AI_LIKENESS_SETTINGS` deep-link. Checked = feature ON. |
| Save | `button "Сохранить изменения"` (RU) / *Save changes* | **Disabled until a change is pending** — a no-op edit leaves it greyed, so an accidental save is impossible. |
| Cancel | `button "Отменить изменения"` (RU) / *Cancel* | |

**Interaction pattern proven live (CEO, board session):** navigate to the section
deep-link → the setting row has a **pencil** icon to enter edit mode → toggle the checkbox
→ **СОХРАНИТЬ / Save** → **reload** the deep-link and re-read to confirm persistence. (In
the attended capture the section expanded directly to the checkbox; on some rows the
pencil is the affordance to enter edit mode first — expect either.)

1. **Verify current state** with `read_page` / `screenshot` (above).
2. **Flip** with `fill_and_submit` (or `run_js` toggling the checkbox), then click Save:

```bash
python3 /home/ievgen/paperclip/scripts/browser_bridge.py '{
  "command": "fill_and_submit",
  "url": "https://admin.google.com/ac/managedsettings/47208553126/AI_LIKENESS_SETTINGS",
  "profile": "gworkspace-admin",
  "fields": [{"selector": "form input[type=checkbox]", "value": "on", "action": "check"}],
  "submit_selector": "button[aria-label*=\"Сохранить\"], button:has-text(\"Сохранить\")",
  "timeout_ms": 45000
}'
```

3. **Re-verify** with another `read_page`/`screenshot` and confirm the new state.
   Save the screenshot as evidence (`evidence_dir`).

> ⚠️ **Do not flip My Avatar ON as a mere write-drill.** Per **AUR-3640** (done), the
> company decision is to keep the Gemini face/voice avatar feature **OFF** (biometric
> likeness). It is currently OFF and must stay OFF absent an explicit, recorded policy
> exception. Use a **benign, reversible** setting for any flip-mechanic demonstration and
> restore it; treat My Avatar as read-only unless a policy change is authorized.

This "read → change → read-back" loop is the acceptance test: an agent confirms the flip
without a human in the loop, **once the host profile is seeded** (see seed note — the seed
must live in the host profile dir driven by the headless bridge, not an operator's
attended laptop browser).

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
   full gate). — **Done 2026-07-22.**
2. **Operator:** seed the profile once via VNC on `78.153.195.107`. Run the helper (it
   auto-resolves Playwright's bundled Chromium — the exact binary the headless bridge
   reuses — so there is no cookie-store/version skew):

   ```bash
   scripts/seed_admin_profile.sh          # profile: gworkspace-admin, DISPLAY=:99
   ```

   Complete super-admin login + 2FA in the window, then **close it** (cookies persist to
   `/home/ievgen/browser-profiles/gworkspace-admin/`).

   > **Two corrections vs. the earlier draft:** (a) the host's Xvfb display is **`:99`**,
   > not `:1`; (b) the browser must be **Playwright's bundled Chromium**, not system
   > `chromium-browser`/`google-chrome`. `seed_admin_profile.sh` handles both.
   >
   > **The seed must land in the HOST profile dir**, not an operator's laptop browser.
   > Logging into `admin.google.com` in an attended browser (e.g. via a browser-MCP
   > extension on a laptop) does **not** seed this profile — the headless bridge on the
   > host reads only `/home/ievgen/browser-profiles/gworkspace-admin/`. Verify with a
   > `read_page` at `admin.google.com`: if it still redirects to `accounts.google.com`,
   > the host profile is not seeded yet.
3. **Agent:** run the read/toggle recipe above; capture concrete deep-links + selectors
   and harden this doc. — Read half + deep-links + selectors captured 2026-07-22 via an
   attended browser-MCP session (AUR-3769); the headless non-interactive half is pending
   the host-profile seed in step 2.

---

## Hardening — captured live 2026-07-22 (AUR-3769)

Captured during the first live admin-console session (attended browser-MCP, super-admin
`board@tryauranode.com`) and committed above:

- ✅ **Deep links** — real `admin.google.com/u/2/ac/managedsettings/<serviceId>` links for
  Gemini app, My Avatar (`.../AI_LIKENESS_SETTINGS`), Gemini for Workspace, Gemini
  Enterprise, NotebookLM (see the deep-link table). Replaced the 404 `/ac/apps/gemini`
  placeholder.
- ✅ **Selectors** — My Avatar toggle is a checkbox
  `input[type=checkbox][aria-label="Включить аватар в Gemini"]` (locale-stable fallback:
  the single `form input[type=checkbox]` on the `AI_LIKENESS_SETTINGS` page); Save button
  `"Сохранить изменения"` is disabled until a change is pending.
- ✅ **Read-state baselines** — Gemini Service status = **ON for everyone**; My Avatar =
  **OFF** (`checked=false`), OU `Auranode e.U.`. Baseline screenshots captured in the
  AUR-3769 session transcript (attended browser-MCP ran on the operator laptop, so those
  images live with the run, not the host); the host evidence dir
  `/home/ievgen/browser-bridge/evidence/aur3769/` holds the Phase-1 auth-wall screenshot.
  Once the host profile is seeded, re-capture the two baselines on-host via
  `browser_bridge.py screenshot … evidence_dir=…`.

**Still pending (one gate):** a headless, non-interactive read/flip via
`browser_bridge.py` — blocked only on seeding the **host** profile dir (step 2 above). The
write-mechanic demonstration should use a benign, reversible setting (My Avatar stays OFF
per AUR-3640) and restore it.
