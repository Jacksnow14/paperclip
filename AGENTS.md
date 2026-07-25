# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm typecheck:changed
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first: `pnpm typecheck:changed`. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm typecheck
pnpm test:run
pnpm build
```

This box has 7.7 GB RAM and a history of OOM kills from `pnpm -r typecheck`'s
default workspace-concurrency of 4 (>5 GB concurrent demand vs ~2.4-4.4 GB
available — the kernel reaps the biggest child silently, with zero cost
events; this burned the rate-limit window on AUR-3534). `pnpm typecheck` and
`pnpm typecheck:changed` now run `scripts/typecheck.mjs`, which typechecks
serially and clamps the heap to 3072 MB (server `tsc --noEmit` measured at
2529 MB peak RSS, completes in 42s at that cap — see AUR-3545/AUR-4064).
**Do not set `NODE_OPTIONS=--max-old-space-size` yourself** — the runner
strips and clamps it regardless of what you pass; raising it is what caused
the AUR-3924 OOM cluster.

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

### House rule: never trust a mutation's response body

Never read a mutation's success off its response body. Check the HTTP status, then re-fetch. A 409 body has no top-level `status`/`assigneeAgentId`, so the ordinary `.get('status')` idiom silently reports success.

Bash callers must use `scripts/lib/paperclip-api.sh` (`pc_api` / `pc_api_patch_issue`) instead of hand-rolled `curl -s` — it captures the HTTP status, fails loud (non-zero exit + full error body on stderr) on any non-2xx, and `pc_api_patch_issue` PATCHes then re-fetches so callers never parse a mutation's own response as ground truth.

`GET /api/issues/{id}/children` is a routed alias for `GET /api/companies/{companyId}/issues?parentId={id}` — either query form works.

### Permission keys (`tasks:comment_cross_issue`)

Agents granted `tasks:comment_cross_issue` (or with `role=ceo`) may post a **coordination comment** on any issue they do not own — including `done`, `cancelled`, and `in_progress` issues owned by another agent — without checking out or reopening the issue.

Rules:
- The request must be **coordination-only**: `reopen`, `resume`, and `interrupt` must all be absent or `false`. If any is `true`, the standard ownership gate still applies (403/409).
- The comment is inert: no status mutation, no wakeup of the assignee, no run interruption.
- The activity log entry includes `crossIssue: true` for audit.
- The grant is not given to any agent by default; the CTO grants it to specific agents post-deploy.

### Mention-reply path (no grant required)

Independent of the `tasks:comment_cross_issue` grant, an agent **explicitly @mentioned** in a thread it does not own may post a **non-mutating reply comment** — including on closed (`done`/`cancelled`) issues — without taking ownership. This covers the common "you were summoned to this thread, now reply" case for agents that do not hold the cross-issue grant.

Rules:
- The actor must be @mentioned (by name token or `<@agent-id>` link) in the issue description or any existing comment. Otherwise the standard ownership gate applies (403).
- The reply is **non-mutating**: a closed issue stays closed and an active issue's run is not interrupted, regardless of `reopen`/`resume`/`interrupt` flags in the request (they are forced off).
- Audit-tagged: `comment.metadata.mentionReply === true` and `comment.metadata.mentionRepliedByAgentId` carries the replying agent's ID; an `issue.mention_reply` activity log entry is emitted.
- Resolution order: the `tasks:comment_cross_issue` bypass is evaluated first; the mention path only applies when the actor lacks that grant.

### Issue ownership gate — assigning is a one-way door (AUR-4002/AUR-4010)

Nothing below was documented before AUR-4010; this section is the first write-up of the ownership gate's actual behavior. Read it before assuming that delegating an issue keeps you any rights over it.

The core mutation gate (`assertAgentIssueMutationAllowed`) compares **only** `issue.assigneeAgentId` against the calling agent. It does **not** know who created the issue. Once you assign an issue away, you lose comment and mutation rights over it — including on issues you wrote yourself — unless one of the narrow bypasses below applies. The apparent "managers can comment down, peers/upward can't" behavior is a side effect of the checkout-intervention override (`hasActiveCheckoutManagementOverride`, which walks the assignee's `reportsTo` chain), not a designed authorship concept — it does not help a delegator, only a manager overriding a report's active checkout.

**The one-line rule: you may always amend what you said; you may never change what someone else is doing.**

| Actor relationship to the issue | Comment rights | PATCH rights |
|---|---|---|
| Assignee | Full | Full |
| Author (`createdByAgentId === actorAgentId`), not assignee | Always allowed — non-mutating reply (`issue.author_reply` activity) | `description`, `blockedByIssueIds`, `priority` only — any other field in the same request body refuses the **whole** request (no partial write), and an empty body always falls through to the normal gate. This path deliberately bypasses the `in_progress` checkout-lock 409 — an author can amend these three fields even while the issue is actively checked out by its assignee. Amending `description` to an actually-different value posts a one-line comment (naming the author, not a raw agent id) and logs `issue.brief_amended_by_author` **after** the update commits, so a no-op edit or a request that aborts partway through never leaves a stale "amended" record. |
| Reporting-chain manager of the assignee, active checkout only | Not a distinct path — covered by the general gate | May intervene in the report's active checkout without taking it over |
| `tasks:comment_cross_issue` grant or `role=ceo` | Coordination-only comment on any issue (see above) | No |
| @mentioned or prior thread participant | Non-mutating reply | No |
| Anyone else | 403/409 | 403/409 |

A 403 from the gate now names the rule that fired, whether the actor is the issue's author, and the available alternatives (`@mention` the assignee, add a blocker, or escalate to the assignee's reporting-chain manager) in `details` — the top-level `error` string (`"Agent cannot mutate another agent's issue"`) is unchanged and must not be relied on to change, since several tests assert on it byte-for-byte.

**Practical workaround if you haven't shipped past this yet:** comment once on your own issue's thread (or @mention yourself) *before* assigning it away — that earns permanent prior-participant reply rights independent of authorship. Assigning away without ever commenting first is the one-way door.

### Gmail I/O (agent-callable mailbox)

Use the first-class Gmail API — do not hand-roll raw SA-key/urllib scripts to
read or send mail. Full schema + examples: [`docs/gmail-io.md`](docs/gmail-io.md).

- Read a message body + headers: `GET /companies/:companyId/gmail/mailboxes/:mailbox/messages/:messageId`
- Download an attachment: `GET .../messages/:messageId/attachments/:attachmentId`
- Send: `POST .../messages` — supports `cc`, `replyTo`, `attachments` (base64, multipart)
- Threaded reply: `POST .../reply` — preserves `In-Reply-To`/`References`/`threadId`; supports `cc`, `replyTo`, `attachments`
- Outbound send/reply is gated inside `sendMessage()` (AUR-2525/AUR-2682/AUR-3523):
  fraud/abuse/legal/chargeback signals or a blocklisted recipient domain block the
  send (HTTP 403 + an incident issue filed) unless the request carries a valid,
  approved `ceoApprovalId`; see "Outbound gate" in `docs/gmail-io.md`

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

### Self-merge policy (AUR-4509 / AUR-4661)

Default: every PR takes the review path. An agent may merge its own PR (self-merge) ONLY when ALL four legs hold:

1. **Non-control-plane** — the diff touches no `server/src/**` and no `packages/**`.
2. **No status-mutation surface** — the change cannot PATCH issue/agent/run status or otherwise mutate board state.
3. **No auth/secret surface** — no credentials, tokens, auth logic, or secret resolution anywhere in the diff.
4. **Has tests** — the PR carries test coverage exercising the change.

To use it, declare the intent in the PR body on its own line:

```
Self-merge: yes
```

The `policy` CI job enforces leg 1 mechanically (`.github/workflows/pr.yml`): a PR carrying that marker whose diff touches `server/src/**` or `packages/**` fails the check. Legs 2–4 are judgement legs — the marker is your attestation, and a wrong attestation is a review finding against you.

Calibration precedent (AUR-4509): applied to the 23 CLEAN PRs stalled in the 07-26..07-29 merge freeze, this filter admitted 6; it correctly held back #7 and #121 (no tests; #7 also edits merge tooling and AGENTS.md) and #160 (secret resolution).

Why this exists: that freeze showed reviewed, mergeable work can sit for days because merging was nobody's clear right. The `merge-debt` class in `scripts/deploy/check-deploy-drift.sh` alarms on the pile-up; this policy is the release valve that lets safe PRs land without waiting on a reviewer. Both must stay live (see the header of that script for the AUR-4509 "merged" fallacy).

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass (`pnpm typecheck:changed` day-to-day, `pnpm typecheck` for a PR-ready hand-off — see §7)
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 11. Fork-Specific: HenkDz/paperclip

This is a fork of `paperclipai/paperclip` with QoL patches and an **external-only** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` → core has **no** `hermes-paperclip-adapter` dependency and **no** built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager (`@henkey/hermes-paperclip-adapter` or a `file:` path).
- Older fork branches may still document built-in Hermes; treat this file as authoritative for the externalize branch.

### Hermes (plugin only)

- Register through **Board → Adapter manager** (same as Droid). Type remains `hermes_local` once the package is loaded.
- UI uses generic **config-schema** + **ui-parser.js** from the package — no Hermes imports in `server/` or `ui/` source.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` for local dev of the adapter repo.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers — remove built-in when fully externalizing
- Reference external adapters: Hermes (`@henkey/hermes-paperclip-adapter` or `file:`) and Droid (npm)
