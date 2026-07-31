#!/usr/bin/env bash
# paperclip-mem-watch regression harness (AUR-4170).
#
# Guards the `oom_5min` derivation in scripts/paperclip-mem-watch.sh — the
# kernel-only fix from AUR-4126:
#
#     journalctl -k --since "-5min" --no-pager | grep -cE "oom-kill:"
#
# History this must never regress to (AUR-4119 defects, AUR-4126 intake):
#   gen 1: grep "killed by the OOM killer"  — one kernel kill echoes once per
#          ancestor cgroup slice (measured 1 kill -> up to 6 lines over 24min).
#   gen 2: unrestricted `journalctl | grep -ci 'oom-kill'` — counts every
#          unit's text, including this company's own request logs. Verified
#          self-poisoning app-log bodies at 2026-07-25 23:13:05 UTC and
#          2026-07-26 02:17:16 UTC (a logged 404 whose reqBody quotes
#          `journalctl -k ... grep -ci 'oom-kill'` — the fix's own commentary
#          poisoning the metric it fixes).
#   truth: the real kernel kill at 2026-07-25 22:52:50 UTC must still count,
#          and count EXACTLY once, not once per line of its 4-line kill block.
#
# Method: hermetic, no root, no live journal. A stub `journalctl` on PATH
# emits fixture streams and encodes the transport semantics that make the fix
# correct BY CONSTRUCTION: with `-k` only kernel-transport lines exist; app
# log text can only ever appear on the unrestricted stream. The REAL sampler
# script is then run end-to-end (log redirected via PAPERCLIP_MEM_WATCH_LOG,
# the AUR-4056 test seam) and the oom_5min column is asserted from the row it
# wrote — so this harness always tests whatever derivation the canonical
# script currently contains, not a copy of it that could drift.
#
# The harness also proves it can DISCRIMINATE (a gate is only proven by a
# passing case and a failing case): the gen-2 derivation is run against the
# same fixture streams and asserted to produce the WRONG answers. If someone
# reverts the sampler to unrestricted grep, the negative scenario here fails;
# if someone loosens the matcher to case-insensitive substring, the positive
# scenario counts "invoked oom-killer:" too and fails the exactly-once bar.
#
# Exit 0 = all assertions pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/paperclip-mem-watch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }
check_ge(){ if [[ "$2" -ge "$3" ]]; then ok "$1"; else bad "$1 (want >= $3, got '$2')"; fi; }

[[ -f "$SCRIPT" ]] || { echo "FATAL: $SCRIPT not found" >&2; exit 1; }

# --- fixtures ---------------------------------------------------------------
# The real kill block, kernel transport, modeled on the verified genuine kill
# at 2026-07-25 22:52:50 UTC. Four lines describe ONE kill; only the
# `oom-kill:` line may count.
cat > "$TMP/kernel_kill.log" <<'EOF'
Jul 25 22:52:50 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: claude invoked oom-killer: gfp_mask=0x1100cca(GFP_HIGHUSER_MOVABLE), order=0, oom_score_adj=600
Jul 25 22:52:50 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/user.slice/user-1000.slice,task=node,pid=733441,uid=1000
Jul 25 22:52:50 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: Out of memory: Killed process 733441 (node) total-vm:11223344kB, anon-rss:5566778kB, file-rss:0kB, shmem-rss:0kB, UID:1000
Jul 25 22:52:51 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: oom_reaper: reaped process 733441 (node), now anon-rss:0kB, file-rss:0kB, shmem-rss:0kB
EOF

# Kernel transport with no OOM activity at all.
cat > "$TMP/kernel_benign.log" <<'EOF'
Jul 26 02:17:00 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)
Jul 26 02:17:10 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com kernel: TCP: request_sock_TCP: Possible SYN flooding on port 3100. Sending cookies.
EOF

# Non-kernel poison, modeled on the two REAL self-poisoning bodies verified in
# AUR-4126 intake (23:13:05 is a shortened copy of the actual journal line: a
# logged 404 whose reqBody quotes the derivation command). Together these
# lines carry every token the acceptance bar names: `oom-kill`, `oom_reaper`,
# and `journalctl -k ... grep -ci 'oom-kill'` — plus the gen-1 cgroup echo
# text for completeness.
cat > "$TMP/app_poison.log" <<'EOF'
Jul 25 23:13:05 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com paperclip[733305]: [23:13:05] WARN: PATCH /companies/b26d3647-3e6c-4a28-9c25-e9315696484d/routines/84317512-ad37-4b32-8cbe-45fbd01c934c 404 {"reqBody":{"description":"...journalctl -k --since \"-6h\" 2>/dev/null | grep -ci 'oom-kill' || echo 0..."}}
Jul 26 02:17:16 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com claude[812345]: issue comment prose: the sampler greps for oom-kill lines and ignores oom_reaper echoes; do not treat zero as an all-clear
Jul 25 23:13:07 N7IdCJiG2H3gXiPUgNa5.tradoxvps.com paperclip[733305]: request body quoted: "A process was killed by the OOM killer" (ticket text, not a kernel event)
EOF

# --- stub journalctl --------------------------------------------------------
# Encodes the transport semantics: `-k` -> kernel stream only; without `-k`
# the app/unit text is present too. Which fixture backs each stream is
# switched per scenario via MEMWATCH_FIXTURE_{KERNEL,APP}.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
kernel_only=no
for a in "$@"; do [[ "$a" == "-k" ]] && kernel_only=yes; done
cat "$MEMWATCH_FIXTURE_KERNEL"
[[ "$kernel_only" == yes ]] || cat "$MEMWATCH_FIXTURE_APP"
exit 0
EOF
chmod +x "$TMP/bin/journalctl"
export MEMWATCH_FIXTURE_KERNEL MEMWATCH_FIXTURE_APP

# Run the real sampler end-to-end against the stub; capture its exit code.
# Everything else the script samples (free, /proc, pgrep, systemctl, runuser)
# runs for real and degrades to NA/0 off-host by the script's own design.
run_sampler() { # $1 = csv log path
  PATH="$TMP/bin:$PATH" PAPERCLIP_MEM_WATCH_LOG="$1" \
    bash "$SCRIPT" >"$TMP/out" 2>"$TMP/err"
  echo $?
}
col()  { awk -F, -v c="$2" 'NR==2{print $c}' "$1"; }   # row 2: header is row 1
cols() { awk -F, 'NR==2{print NF}' "$1"; }
# The gen-2 derivation, verbatim shape (unrestricted journal, case-insensitive
# substring). Kept ONLY to prove the fixtures discriminate old from new.
old_derivation() { "$TMP/bin/journalctl" --since "-5min" --no-pager | grep -ci "oom-kill"; }

echo "== positive control: one real kernel kill, poison also present =="
MEMWATCH_FIXTURE_KERNEL="$TMP/kernel_kill.log"
MEMWATCH_FIXTURE_APP="$TMP/app_poison.log"
check "sampler exits 0"                          "$(run_sampler "$TMP/pos.csv")" 0
check "oom_5min counts the kill EXACTLY once (4-line kill block, poison ignored)" \
                                                 "$(col "$TMP/pos.csv" 8)" 1
check "row still has the full 18-column schema"  "$(cols "$TMP/pos.csv")" 18

echo "== negative regression: no kernel kill, only app-log poison =="
MEMWATCH_FIXTURE_KERNEL="$TMP/kernel_benign.log"
MEMWATCH_FIXTURE_APP="$TMP/app_poison.log"
check "sampler exits 0"                          "$(run_sampler "$TMP/neg.csv")" 0
check "oom_5min is 0: oom-kill/oom_reaper/journalctl-quoting app lines do not count" \
                                                 "$(col "$TMP/neg.csv" 8)" 0

echo "== discrimination: the retired gen-2 grep gets BOTH scenarios wrong =="
# These two checks are what make the harness a regression test rather than a
# tautology: under the old unrestricted-grep logic the two assertions above
# would have read 4 and 2, i.e. the suite fails on pre-AUR-4126 logic.
check_ge "gen-2 grep counts poison as kills on the negative stream (would fail ==0 bar)" \
                                                 "$(old_derivation)" 1
MEMWATCH_FIXTURE_KERNEL="$TMP/kernel_kill.log"
check_ge "gen-2 grep over-counts the single kill (would fail ==1 bar)" \
                                                 "$(old_derivation)" 2

echo "== canonical-source drift check (runs only on the prod host) =="
LIVE=/usr/local/sbin/paperclip-mem-watch.sh
if [[ -r "$LIVE" ]]; then
  check "repo copy is byte-identical to $LIVE" \
        "$(sha256sum "$LIVE" | cut -d' ' -f1)" \
        "$(sha256sum "$SCRIPT" | cut -d' ' -f1)"
else
  echo "  SKIP  $LIVE not readable here — not the prod host (CI is expected to land in this branch)"
fi

echo
echo "paperclip-mem-watch.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
