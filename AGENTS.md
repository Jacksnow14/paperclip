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
pnpm -r typecheck
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

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

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

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 12. Routing Rationale Convention (Manager Agents)

Any manager agent (CEO, CMO, CFO, or future manager roles) that routes a `priority: high` or `critical` issue to another agent **must** capture a routing rationale record in Paperclip Memory immediately after assignment.

**Record key:** `routing/{issueId}`

**Required metadata fields:**

| Field | Type | Description |
|---|---|---|
| `category` | string | Always `"routing_rationale"` |
| `issue_id` | string | The issue identifier (e.g. `AUR-1500`) |
| `candidates_considered` | string[] | Agent IDs that were evaluated |
| `scorecard_summary` | object | Per-candidate: `{ quality_signal, rework_required_count, n_samples }` |
| `chosen_agent` | string | Agent ID of the assignee |
| `rationale` | string | One-line decision reason |
| `data_available` | boolean | `true` if scorecard data existed; `false` if fell back to role-based |

**When no scorecard data exists:** set `data_available: false` and note `"No scorecard data — fell back to role-based routing"` in `rationale`. This is allowed but must be explicit.

**Reference implementation:** CEO AGENTS.md — `## Memory and planning` → "Routing rationale capture" section with a full worked example.

**Detection:** A watchdog routine (`routing-rationale-watchdog`) runs every 30 minutes. It queries all high/critical issues with an assignee and flags any that are missing `routing/{issueId}` records in memory. The detection script can also be run manually:

```sh
node scripts/check-routing-rationale.mjs
```

## 13. Tool-Gap Logging

When any agent hits a missing capability or must use a workaround, capture a Paperclip Memory record via `POST /api/companies/:companyId/memory/capture`. The Memory API has no native `key` field — encode the key in `title`:

```json
{
  "title": "tool-gaps/YYYY-MM-DD/<your-agentId>/<capability-slug>",
  "metadata": {
    "category": "tool_gap",
    "capability_needed": "<what you needed>",
    "workaround_used": "<what you did instead>",
    "estimated_cost_of_workaround": "<token or time estimate>",
    "frequency": "one-off | recurring"
  },
  "scope": { "projectId": "<include when the issue belongs to a project>" },
  "source": "<current issue ID and run reference>"
}
```

Omit `scope.projectId` for gaps with no project affiliation. This data feeds the SGI Loop review cycle.

**The loop is live:** gaps you log are reviewed weekly every Monday 09:00 UTC by the CTO triage routine. Top recurring gaps become capability-gap issues automatically — see [AUR-1447](/AUR/issues/AUR-1447) for the triage tracking log.

## 14. Prompt Self-Edit Flow (SGI Loop C)

The system can trigger prompt self-improvement when an agent's performance declines. All agents must follow this protocol when assigned a self-edit issue.

### Trigger Conditions

A daily detection routine (cron 06:00 UTC, owned by CTO) scans `performance/{agent}/{task_type}/*` scorecards in Paperclip Memory. A self-edit issue is opened for an agent when the **last 3 closed scorecards** for a given `{agent}/{task_type}` show:
- **Declining quality**: `quality_signal` is strictly monotonically decreasing (e.g. 4 → 3 → 2), OR
- **Repeated rework**: all 3 have `rework_required: true`

### Agent Protocol: When Assigned a Self-Edit Issue

When you receive an issue titled `Prompt self-edit required — {your-agent-id} / {task_type}`:

1. **Read your own AGENTS.md** (your `instructions-path` file).
2. **Identify the responsible section** — the instructions that govern the `{task_type}` work where quality declined.
3. **Post a memory record** titled `prompt-improvement-proposal/{agentId}/{YYYY-MM-DD}`:

   ```json
   {
     "title": "prompt-improvement-proposal/{agentId}/{YYYY-MM-DD}",
     "content": "<one-line summary of the proposed change>",
     "metadata": {
       "category": "prompt_improvement_proposal",
       "agent_id": "{your-agent-id}",
       "task_type": "{task_type}",
       "triggering_pattern": "<one-line: what went wrong in the last 3 runs>",
       "current_instruction_excerpt": "<verbatim excerpt from your AGENTS.md being replaced>",
       "proposed_edit": "<diff or full replacement of the affected section>",
       "rationale": "<why this change prevents the pattern>",
       "expected_impact": "<quality_signal improvement expected>"
     }
   }
   ```

4. **Create a board approval** (`POST /api/companies/{companyId}/approvals`, `type: request_board_approval`) with:
   - `title`: `Self-edit proposal: {agentId} / {task_type}`
   - `summary`: brief description of the problem and proposed fix
   - `recommendedAction`: "Apply the proposed_edit to the agent's AGENTS.md"
   - `risks`: ["Instruction change may affect behavior beyond the target task type"]
   - `issueIds`: [this self-edit issue's id]

5. **Set this issue `in_review`**, assigned to the CEO.

### Safety Boundaries (Non-negotiable)

- **Self-edit only.** You may ONLY propose changes to YOUR OWN `instructions-path` file.
- **Never propose edits** to: other agents' instruction files, the root repo `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, or any governance document.
- The CEO enforces this in review — proposals targeting non-self files are automatically rejected.
- All proposals are captured to memory regardless of approval outcome (auditable history).

### CEO Approval Protocol

When a `request_board_approval` arrives for a self-edit proposal:

1. Fetch the `prompt-improvement-proposal/{agentId}/{YYYY-MM-DD}` memory record.
2. **Verify** the proposed edit targets **only** the agent's own `instructions-path` file. Reject immediately if not.
3. Assess the proposed change for correctness, safety, and alignment with agent role.
4. **On approval**: apply the diff/replacement to the agent's AGENTS.md (Edit tool), then update the memory record with `outcome: approved`.
5. **On rejection**: update the memory record with `outcome: rejected` and a `rejection_reason` field.

### Detection Routine

- Name: `SGI Loop C — Scorecard Streak Detection`
- Owner: CTO (agent `371a1b08-0286-4a12-a516-f587f42df5eb`)
- Schedule: daily 06:00 UTC
- Parent: [AUR-1395](/AUR/issues/AUR-1395) — SGI Path

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
