#!/usr/bin/env bash
# hostguard — audit + intent gate for company-ending host operations (AUR-3941)
#
# WHY THIS EXISTS, AND WHY IT IS NOT A SUDO POLICY
# ------------------------------------------------
# AUR-3924 concluded that passwordless root was the near-miss vector and that
# polkit caught it. Both are wrong (verified 2026-07-25):
#
#   * There is NO system-level `paperclip.service`. It is a --user unit at
#     ~/.config/systemd/user/paperclip.service. `sudo systemctl stop
#     paperclip.service` fails with "Unit not found" — sudo would NOT have
#     dropped the control plane. `systemctl --user stop paperclip.service`
#     would have, and that needs NO root, NO sudo, and NO polkit.
#   * paperclip-db.service runs `User=ievgen`, and its datadir
#     (~/paperclip-data/instances/default/db) is ievgen-owned inside an
#     ievgen-writable parent. `rm -rf` on the live database needs NO root.
#
# So every company-ending operation on this host is reachable WITHOUT
# privilege. A sudoers change would have gated none of them. The boundary that
# matters is the user command layer — which is where this shim sits.
#
# DESIGN CONTRACT
#   1. FAIL OPEN. This is an audit + friction layer, not a security boundary
#      against a hostile actor. Any internal error execs the real binary. A
#      guard that breaks agent autonomy is a worse regression than the risk it
#      mitigates (AUR-3941 constraint).
#   2. LOG EVERYTHING MUTATING, BLOCK ALMOST NOTHING. Reads pass through
#      unlogged. Mutations are logged and allowed unattended. Only the
#      company-wide blast-radius set requires explicit intent.
#   3. ATTRIBUTABLE. Every record carries PAPERCLIP_AGENT_ID / ISSUE / RUN_ID,
#      which sudo's env_reset strips and auth.log therefore never had.
#
# Invoked via argv[0] shims: systemctl, rm.

set -uo pipefail

AUDIT_LOG="${HOSTGUARD_LOG:-/var/log/hostguard/audit.jsonl}"
# Overridable only so the test harness can prove behaviour without touching the
# live control plane. Production values are the real binaries.
REAL_SYSTEMCTL="${HOSTGUARD_REAL_SYSTEMCTL:-/usr/bin/systemctl}"
REAL_RM="${HOSTGUARD_REAL_RM:-/usr/bin/rm}"
NOTIFY="${HOSTGUARD_NOTIFY:-/home/ievgen/bot/notify_founder.sh}"

# --- protected targets: the set that drops the control plane, the database, or
# --- the data directory. Deliberately short. Everything else is autonomy.
PROTECTED_UNITS_RE='^(paperclip|paperclip-db|paperclip-oom-guard|paperclip-mem-watch|postgres.*)(\.(service|timer))?$'
DESTRUCTIVE_VERBS_RE='^(stop|disable|mask|kill)$'
# NOTE: these are bash glob PATTERNS, matched unquoted. Scope them as tightly as
# possible. `/home/ievgen/paperclip-data/instances` would be catastrophically
# wrong here: agent workspaces live under
# instances/<id>/projects/... and every routine `rm` in a workspace would be
# refused. Guard the database directory, not the tree that contains it.
PROTECTED_PATHS=(
  "/home/ievgen/paperclip-data/instances/*/db"
  "/opt/paperclip/postgres"
  "/home/ievgen/.config/systemd/user/paperclip.service"
  "/etc/systemd/system/paperclip-db.service"
)

# Normalise a path WITHOUT forking. `rm` is on every build's hot path and every
# agent workspace lives under /home/ievgen/paperclip-data, so a `readlink -m`
# per argument costs ~5ms/arg — measured 9.5s for a 2000-arg `rm` in a
# workspace, a ~100x regression. Pure bash does the same job in-process.
# Result is written to the global NORM.
normalize_path() {
  local p="$1" part out=()
  [[ "$p" != /* ]] && p="$PWD/$p"
  local IFS=/
  for part in $p; do
    case "$part" in
      ''|.) ;;
      ..)   [[ ${#out[@]} -gt 0 ]] && unset 'out[${#out[@]}-1]' ;;
      *)    out+=("$part") ;;
    esac
  done
  NORM="/${out[*]:-}"
  [[ "$NORM" == "/" && ${#out[@]} -eq 0 ]] && NORM="/"
}

json_escape() { printf '%s' "${1-}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g' | tr -d '\000-\037'; }

# Append one attributable record. Never fails the caller.
audit() {
  local decision="$1" tool="$2" reason="$3"; shift 3
  local argv="" a
  for a in "$@"; do argv="${argv}${argv:+ }$(json_escape "$a")"; done
  {
    printf '{"ts":"%s","decision":"%s","tool":"%s","reason":"%s","agent_id":"%s","issue":"%s","run_id":"%s","task_id":"%s","user":"%s","euid":%s,"cwd":"%s","ppid":%s,"intent":"%s","argv":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$decision" "$tool" "$(json_escape "$reason")" \
      "${PAPERCLIP_AGENT_ID:-unknown}" "${PAPERCLIP_ISSUE_ID:-${PAPERCLIP_TASK_ID:-unknown}}" \
      "${PAPERCLIP_RUN_ID:-unknown}" "${PAPERCLIP_TASK_ID:-unknown}" \
      "$(id -un)" "$(id -u)" "$(json_escape "$PWD")" "${PPID:-0}" \
      "$(json_escape "${HOSTGUARD_INTENT:-}")" "$argv"
  } >> "$AUDIT_LOG" 2>/dev/null || true
}

refuse() {
  local tool="$1" target="$2"; shift 2
  audit "refused" "$tool" "protected target: $target" "$@"
  cat >&2 <<EOF
hostguard: REFUSED — '$target' is a company-wide blast-radius target.

  attempted: $tool $*
  reason:    stopping/deleting this drops the control plane, the database,
             or the data directory for the entire company.

This is friction, not a wall. If you genuinely intend this, restate intent:

  HOSTGUARD_INTENT="AUR-XXXX: why this is necessary" $tool $*

That path is allowed, logged to $AUDIT_LOG, and alerts the founder.
Routine ops (start, restart, enable, daemon-reload, status, timers) are
unaffected and need no intent.
EOF
  exit 87
}

# ---------------------------------------------------------------- systemctl --
guard_systemctl() {
  local verb="" unit_args=() a
  for a in "$@"; do
    case "$a" in
      -*) continue ;;
      *) if [[ -z "$verb" ]]; then verb="$a"; else unit_args+=("$a"); fi ;;
    esac
  done

  # Read-only verbs: pass through silently. Keeps the log signal-dense.
  case "$verb" in
    ""|status|show|cat|list-units|list-unit-files|list-timers|list-sockets|list-jobs|\
    is-active|is-enabled|is-failed|get-default|show-environment|help|--version)
      exec "$REAL_SYSTEMCTL" "$@" ;;
  esac

  if [[ "$verb" =~ $DESTRUCTIVE_VERBS_RE ]]; then
    for a in "${unit_args[@]:-}"; do
      [[ -z "$a" ]] && continue
      if [[ "${a%.service}" =~ $PROTECTED_UNITS_RE || "$a" =~ $PROTECTED_UNITS_RE ]]; then
        if [[ -z "${HOSTGUARD_INTENT:-}" ]]; then
          refuse "systemctl" "$a" "$@"
        fi
        audit "escalated" "systemctl" "protected unit '$a' allowed via explicit intent" "$@"
        [[ -x "$NOTIFY" ]] && "$NOTIFY" \
          "hostguard: ${PAPERCLIP_AGENT_ID:-agent} ran 'systemctl $verb $a' with intent: ${HOSTGUARD_INTENT}" \
          >/dev/null 2>&1 &
        exec "$REAL_SYSTEMCTL" "$@"
      fi
    done
  fi

  # Every other mutation: logged, allowed unattended. This is the autonomy path.
  audit "allowed" "systemctl" "routine mutation" "$@"
  exec "$REAL_SYSTEMCTL" "$@"
}

# ----------------------------------------------------------------------- rm --
guard_rm() {
  local a p pp
  # Cost control: `rm` is on every build's hot path and may get thousands of
  # args, so avoid a readlink subprocess per arg. A path can only resolve INTO a
  # protected dir if it literally names one, or if we are already standing
  # inside a protected tree. Anything else is provably safe to skip.
  local deep_scan=0
  case "$PWD" in /home/ievgen/paperclip-data/*|/opt/paperclip/*) deep_scan=1 ;; esac

  for a in "$@"; do
    [[ "$a" == -* ]] && continue
    if [[ "$deep_scan" -eq 0 && "$a" != *paperclip* && "$a" != *postgres* ]]; then continue; fi
    # Normalise without requiring existence, so ../ tricks still resolve.
    normalize_path "$a"; p="$NORM"
    for pp in "${PROTECTED_PATHS[@]}"; do
      # Refuse the protected target itself and anything beneath it.
      # RHS unquoted so the `*` in the patterns above globs.
      if [[ "$p" == $pp || "$p" == $pp/* ]]; then
        if [[ -z "${HOSTGUARD_INTENT:-}" ]]; then
          refuse "rm" "$p" "$@"
        fi
        audit "escalated" "rm" "protected path '$p' allowed via explicit intent" "$@"
        [[ -x "$NOTIFY" ]] && "$NOTIFY" \
          "hostguard: ${PAPERCLIP_AGENT_ID:-agent} ran 'rm' on $p with intent: ${HOSTGUARD_INTENT}" \
          >/dev/null 2>&1 &
        exec "$REAL_RM" "$@"
      fi
    done
  done
  exec "$REAL_RM" "$@"   # untouched fast path: no log, no behaviour change
}

case "$(basename "${0}")" in
  systemctl) guard_systemctl "$@" ;;
  rm)        guard_rm "$@" ;;
  *)         echo "hostguard: unknown shim name '$(basename "$0")'" >&2; exit 2 ;;
esac
