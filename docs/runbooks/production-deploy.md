# Runbook: production deploys and deploy-drift alerts

Closes [AUR-3937](/AUR/issues/AUR-3937) (parent [AUR-3931](/AUR/issues/AUR-3931) step 4).

For five days production ran `server/dist/index.js` out of a mutable agent checkout. The
directory was gitignored, last built July 20, and mapped to no commit — the only way to
answer "what is production running?" was `ls -la`. Any agent running `pnpm build` in that
checkout silently redeployed whatever branch happened to be checked out, unreviewed. This
runbook is how that stays fixed.

**Rule:** production never runs from `/home/ievgen/paperclip`. That checkout is a working
tree for agents; it is expected to be dirty and to switch branches several times a day.

---

## 1. Where production actually runs

```
/opt/paperclip/app/
├── current -> releases/<sha12>     # atomic symlink; root-owned
└── releases/<sha12>/               # root:root, go-w — immutable once built
    ├── build-info.json             # sha, ref, builtAt, remote, builder
    ├── server/dist/index.js
    └── scripts/deploy/run-server.sh   # the pinned launch command itself
```

`paperclip.service` execs `/opt/paperclip/app/current/scripts/deploy/run-server.sh`, which
resolves the symlink with `pwd -P` before exec — so flipping `current` never yanks the tree
out from under a running process. A release is chowned to `root:root` after build, so no
agent can mutate a deployed artifact even by accident.

`/opt/paperclip/postgres` (AUR-3931) follows the same pattern. Neither is inside
`node_modules` and neither is writable by the agent user.

## 2. Answering "what is production running?"

Never with `ls -la`. Always:

```bash
curl -s http://127.0.0.1:3100/api/health | python3 -m json.tool
```

```json
"build": { "source": "release", "sha": "<40-char>", "ref": "origin/master", "builtAt": "..." }
```

`source` is the field that matters:

| `source`    | meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `release`   | running a pinned, committed, reviewable build. The good state.        |
| `checkout`  | running from a mutable working tree. Not acceptable in production.    |
| *(absent)*  | pre-AUR-3937 binary of unknown provenance. This was the July incident. |

The same block is printed to the journal on startup (`server/src/startup-banner.ts`).

## 3. Deploying

```bash
# builds origin/master into a new release and flips `current`
scripts/deploy/build-release.sh --ref origin/master --activate
systemctl --user restart paperclip.service
```

- The script **refuses** any commit not reachable from an `origin` remote branch. Unpushed
  local work cannot reach production. This is the traceability gate — do not weaken it.
- It **never** restarts the service. Activation applies on the next start, so arming and
  cutting over are separate, individually reversible decisions.
- `NODE_OPTIONS=--max-old-space-size=3072` and `--workspace-concurrency=1` are load-bearing:
  this box has 7.7 GB and a history of OOM kills. Server `tsc` OOMs at 2048 and completes at
  3072 (measured 2026-07-25). **Do not raise this without reading AUR-3937.**
- Restarting `paperclip.service` kills every in-flight agent run — they are children of it.
  The harness re-wakes their issues. Pick a low-activity window; do not defer indefinitely.
  An agent scheduling its own cutover must run the restart **outside** the service cgroup
  (`sudo systemd-run ...`), or it kills itself mid-deploy.

Rollback is a symlink flip plus a restart:

```bash
sudo ln -sfn releases/<previous-sha12> /opt/paperclip/app/current.next
sudo mv -T /opt/paperclip/app/current.next /opt/paperclip/app/current
systemctl --user restart paperclip.service
```

## 4. The drift detector — and who it wakes

`paperclip-deploy-drift.timer` runs `check-deploy-drift.sh` every 15 minutes as a **system**
unit, so it survives control-plane restarts and can report on them. It asks the running
server what it is executing — not the checkout, not the artifact on disk — and compares
against `origin/master`.

```bash
systemctl status paperclip-deploy-drift.service
tail -5 /var/log/paperclip-deploy-drift.log
```

```
2026-07-25T15:51:26Z running=<sha12> activated=<sha12> master=<sha12> status=ok reason=-
```

`status=ok` requires all three to agree **and** `build.source == "release"`.

### This detector is not advisory — it pages, but it pages *graded*

The first version of this check fired DRIFT every 15 minutes for a full day into an empty
room. A detector that correctly identifies a production defect and escalates to no one is
not a control; it is noise that trains us to ignore it. Sustained drift now reaches the
founder via Telegram ([`notify_founder.sh`](/AUR/issues/AUR-3930), SEV2 — the only channel
proven to deliver; mobile push fails silently).

It is graded on purpose, because the two drift classes are not the same event:

| class         | reasons                                                    | pages after |
| ------------- | ---------------------------------------------------------- | ----------- |
| `provenance`  | `untracked-or-unreachable:*`, `armed-release-not-live`      | **2h**      |
| `deploy-debt` | `behind-origin-master`                                      | **24h**     |
| *(none)*      | `UNKNOWN` / `remote-unreachable`                            | never       |

`behind-origin-master` is the **expected** state for a while after every merge — production
is running a real, pinned, reviewed commit that is merely older than master. Paging on that
at 2h would page on every merge and get the channel muted, which is the same failure this
escalation exists to prevent. `provenance` drift is different in kind: it means we cannot
say what production is running, or a deploy was armed and silently never took effect.

Alerts are rate-limited per reason (6h default). Sustained duration is derived from the run
of consecutive same-reason lines in the drift log, so there is no side state to go stale — a
single converged check resets the clock. A page that fails to deliver is logged loudly as
`ESCALATION FAILED` in the journal and is never swallowed.

Tunable via env on the unit: `PAPERCLIP_DRIFT_PROVENANCE_THRESHOLD_SEC`,
`PAPERCLIP_DRIFT_DEBT_THRESHOLD_SEC`, `PAPERCLIP_DRIFT_ALERT_COOLDOWN_SEC`,
`PAPERCLIP_DRIFT_NOTIFY`.

Behaviour is locked down by `scripts/deploy/check-deploy-drift.test.sh` (hermetic: fake git
remote, `file://` health document, stub notifier — no network, no systemd, no node):

```bash
bash scripts/deploy/check-deploy-drift.test.sh
```

### Responding to a page

1. `curl -s http://127.0.0.1:3100/api/health` — read `build.source` first.
2. `source` absent or `checkout` → production is unpinned. Build and activate a release
   (§3) at the next opportunity; this is the highest-severity case.
3. `armed-release-not-live` → `current` was flipped but the service was never restarted.
   Restart it.
4. `behind-origin-master` for >24h → deploy debt. Ship §3.

## 5. Keeping the production checkout clean

`server/src/__tests__/production-deploy-immutability.test.ts` fails if the deployed release
is writable by the agent user, if `paperclip.service` execs anything outside
`/opt/paperclip/app/current`, or if the health payload loses its `build` provenance block.
Workspace selection for agents is owned by AUR-3915/AUR-3913 — do not add a second,
conflicting workspace-resolution rule here.
