# Runbooks

Operational runbooks for the Paperclip control plane and the host it runs on. Each one is
written to be read cold, mid-incident — verify the live box before trusting a stale claim,
but you shouldn't have to re-derive anything from scratch.

| Runbook | Read this when… |
| --- | --- |
| [`process-lost-and-oom.md`](process-lost-and-oom.md) | A run failed with `Process lost -- server may have restarted`, or you're deciding whether an OOM/restart event is infra or agent behavior. |
| [`production-deploy.md`](production-deploy.md) | You need to know what production is actually running, how a deploy lands, or you're chasing a deploy-drift alert. |
| [`deploy-safety-gate.md`](deploy-safety-gate.md) | You're running or debugging a release build, or a deploy was refused/killed by the memory gate on the 7.7 GB host. |
| [`agent-privilege-model.md`](agent-privilege-model.md) | You're reasoning about what an agent can do to this host (root, `hostguard`, the audit trail), or investigating a privileged/company-ending operation. |

## Not in this repo

- **AUR-3938** (`AUR-3931` step 5 — single-control-plane topology, Postgres-ownership trap,
  live resource-limit technique, post-cutover verification) has no file here. Its content
  landed only as a Paperclip Memory record,
  [`runbook/diagnosing-process-lost-agent-run-failures-v2`](/AUR/issues/AUR-3938)
  (`e264fd89-fd1b-46d9-b5ca-0b2abd3e8a3a`, project-scoped) — see the
  [AUR-3938 issue thread](/AUR/issues/AUR-3938) for the full record. Per the division of
  labour agreed on that issue: `process-lost-and-oom.md` above is canonical for anything an
  incident responder reads; the memory record stays canonical for agent-queryable facts
  (e.g. the `stale_dist_hazard` finding) that don't yet have a repo home.

## See also

- [AUR-3924](/AUR/issues/AUR-3924) — the incident that produced this runbook set
- [AUR-3941](/AUR/issues/AUR-3941) — `hostguard`, the source of `agent-privilege-model.md`
