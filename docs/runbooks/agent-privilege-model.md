# Runbook — Agent privilege model and `hostguard`

**Owner:** CTO · **Source:** AUR-3941 (split from AUR-3924) · **Established:** 2026-07-25

Read this instead of re-deriving the privilege model from `sudo -l` during an incident. If
you're diagnosing a `Process lost` report or an OOM/restart event rather than a privileged
operation, start at [`process-lost-and-oom.md`](process-lost-and-oom.md) instead — this
runbook assumes you already know *which* unit is the control plane.

---

## 1. The correction that matters

AUR-3924 concluded that passwordless root was the near-miss vector, and that polkit
caught the `systemctl stop paperclip.service` that was issued during the incident.
**Both conclusions are wrong.** Verified on the host 2026-07-25:

| Claim in AUR-3924 | Reality |
|---|---|
| `sudo -n systemctl stop paperclip.service` would have succeeded silently | It would have **failed too** — there is no system-level `paperclip.service`. It is a `--user` unit at `~/.config/systemd/user/paperclip.service`. |
| Polkit was the guardrail that caught it | Polkit is **never in the path** for a user's own systemd user manager. It caught nothing. |
| Passwordless root is the exposure | Root is a real posture problem, but **it is not the boundary that protects the company**. |

The command that would actually have dropped the control plane is
`systemctl --user stop paperclip.service` — which needs **no root, no sudo, no polkit**.

### Every company-ending operation on this host needs zero privilege

| Operation | Effect | Privilege required |
|---|---|---|
| `systemctl --user stop paperclip.service` | control plane down | **none** |
| `rm -rf ~/paperclip-data/instances/default/db` | database destroyed | **none** (`ievgen`-owned, parent writable) |
| `systemctl stop paperclip-db.service` | database down | sudo (unit is system-level, `User=ievgen`) |

Two of the three sit entirely outside the sudo boundary. **A sudoers change would have
gated none of them.** That is why the guard is a command-layer shim, not a sudo policy.

---

## 2. The boundary

### Root that agents genuinely need — unchanged, unattended, no friction
Installing units/timers · `daemon-reload` · `start`/`restart`/`enable` · `swapon` ·
reading `/proc` · writing `oom_score_adj` · `journalctl` · `dmesg` · package installs.

These are logged when they mutate state, and **never blocked**. Passwordless sudo is
deliberately retained: the CTO used exactly this privilege to install the OOM guard,
the swapfile, and the memory sampler that stabilised the AUR-3924 P0. Revoking it
wholesale would cause the outage it is meant to prevent.

### The protected set — logged, and requires explicit intent
Only operations whose blast radius is company-wide:

- **Units** (`stop`/`disable`/`mask`/`kill` only): `paperclip`, `paperclip-db`,
  `paperclip-oom-guard`, `paperclip-mem-watch`, `postgres*`
- **Paths** (`rm`): `~/paperclip-data/instances/*/db`, `/opt/paperclip/postgres`,
  `~/.config/systemd/user/paperclip.service`, `/etc/systemd/system/paperclip-db.service`

> `restart` is **not** destructive and is not gated. Neither is any read verb
> (`status`, `show`, `is-active`, `list-*`, `cat`) — those pass through unlogged so
> the audit trail stays signal-dense.

> **Scope trap:** the protected path is `instances/*/db`, **never** `instances`.
> Agent workspaces live at `instances/<id>/projects/...`; protecting the parent would
> refuse every routine workspace `rm` and silently destroy agent autonomy.
> `scripts/hostguard.test.sh` has a dedicated regression test for this.

---

## 3. How it works

```
/usr/local/sbin/hostguard.sh          the guard (root-owned; agents cannot edit it)
/usr/local/bin/systemctl -> guard     shim
/usr/local/bin/rm        -> guard     shim
/var/log/hostguard/audit.jsonl        append-only (chattr +a) attributable trail
/etc/sudoers.d/10-hostguard-attribution   env_keep for agent identity + intent
/etc/logrotate.d/hostguard            weekly, 26 rotations
```

`/usr/local/bin` precedes `/usr/bin` in both the agent `PATH` **and** sudo's
`secure_path`, so the same shim covers privileged and unprivileged invocations.

**Design contract:** *fail open*. This is an audit and friction layer, not a security
boundary against a hostile actor. Any internal error execs the real binary — a guard
that breaks agent autonomy is a worse regression than the risk it mitigates.

### Doing a protected operation on purpose

```bash
HOSTGUARD_INTENT="AUR-1234: why this is necessary" \
  systemctl --user stop paperclip.service
```

This is allowed, logged with `decision":"escalated"`, and alerts the founder via
Telegram. Without the variable the command exits **87** with instructions.

### Reading the audit trail

```bash
sudo tail -50 /var/log/hostguard/audit.jsonl | jq .
sudo jq -r 'select(.decision!="allowed") | "\(.ts) \(.agent_id) \(.decision) \(.argv)"' \
  /var/log/hostguard/audit.jsonl
```

Each record carries `agent_id`, `issue`, `run_id`, `task_id`, `cwd`, `euid`, `ppid`,
`intent`, `argv`. This is the attribution `auth.log` never had — sudo's `env_reset`
strips `PAPERCLIP_*`, so privileged operations previously logged as `agent_id=unknown`.
The sudoers drop-in preserves those (non-secret) variables plus `HOSTGUARD_INTENT`.

---

## 4. Escape hatch — if the guard itself ever breaks

The shims are on the `rm` and `systemctl` hot paths. If `hostguard.sh` is corrupted or
deleted, **both commands break host-wide**. Recover by calling the real binaries by
absolute path (they are never modified):

```bash
sudo /bin/rm -f /usr/local/bin/rm /usr/local/bin/systemctl   # remove the shims
/usr/bin/systemctl --user status paperclip.service           # real binary, always works
```

Reinstall with `sudo install -m 0755 scripts/hostguard.sh /usr/local/sbin/hostguard.sh`.

---

## 5. Verification

`bash scripts/hostguard.test.sh` — 39 assertions, stubbed binaries, never touches the
live control plane or database. Proves both halves of the AUR-3941 bar: company-ending
ops are gated and attributable, **and** routine agent autonomy is intact.

---

## 6. Known limits (deliberate, not oversights)

- **Bypassable by design.** `/bin/rm`, `/usr/bin/systemctl`, and direct syscalls skip
  the shim. This is friction for accidents, not containment of a hostile agent.
- **Passwordless root remains.** Removing it was explicitly out of scope; it would
  break the fleet. The mitigation is attribution, not revocation.
- **Not covered:** `dd`, `mkfs`, `truncate`, `shred`, `mv` onto protected paths, and
  `systemctl --user` unit-file deletion via editors. Extend `PROTECTED_PATHS` /
  `PROTECTED_UNITS_RE` if a real incident justifies it — resist speculative expansion,
  every added shim is hot-path cost and regression surface.

---

## See also

- [`process-lost-and-oom.md`](process-lost-and-oom.md) — diagnosing `Process lost` / OOM
  events; §3 there documents the same single-control-plane topology this runbook's §1
  correction relies on
- [`production-deploy.md`](production-deploy.md) — what production is actually running and
  how a deploy lands
- [AUR-3938](/AUR/issues/AUR-3938) — Postgres-ownership trap and live resource-limit
  technique, captured as a Paperclip Memory record rather than a repo file (see
  [`docs/runbooks/README.md`](README.md))
- [AUR-3924](/AUR/issues/AUR-3924) — the incident this whole runbook set traces back to
