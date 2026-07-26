#!/usr/bin/env bash
# AUR-4056 regression test: the sampler must never split a record across lines.
#
# The defect only appears when ZERO agent processes match, because that is the
# only case where `pgrep -c` both prints "0" and exits 1. So the test shims
# pgrep to a guaranteed no-match and asserts the emitted record is one line of
# exactly 18 columns.
set -uo pipefail
pass=0; fail=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
no(){ echo "  FAIL  $1"; fail=$((fail+1)); }

OLD=${1:-/tmp/aur4056_old_testable.sh}   # pre-fix script, LOG made overridable ONLY
NEW=${2:-/tmp/aur4056_new.sh}
SHIM=$(mktemp -d)

# pgrep shim: exact upstream semantics for "no match" -> prints 0, exits 1.
cat > "$SHIM/pgrep" <<'EOF'
#!/bin/bash
for a in "$@"; do [[ "$a" == "-c" ]] && { echo 0; exit 1; }; done
exit 1
EOF
chmod +x "$SHIM/pgrep"
export PATH="$SHIM:$PATH"

echo "== 1. shim reproduces upstream pgrep no-match semantics =="
out=$(pgrep -c -f whatever); rc=$?
[[ "$out" == "0" && $rc -eq 1 ]] && ok "pgrep -c prints 0 and exits 1" || no "shim wrong (out=$out rc=$rc)"

run(){ # $1=script -> echoes "<datarows> <maxNF> <minNF>"
  local log; log=$(mktemp)
  PAPERCLIP_MEM_WATCH_LOG="$log" bash "$1" >/dev/null 2>&1
  awk -F, '/^20[0-9][0-9]-/{n++} !/^ts,/{if(NF>mx)mx=NF; if(mn==0||NF<mn)mn=NF} END{print n+0, mx+0, mn+0}' "$log"
  rm -f "$log"
}

echo "== 2. OLD script (control): must actually WRITE, and must split =="
oldlog=$(mktemp)
PAPERCLIP_MEM_WATCH_LOG="$oldlog" bash "$OLD" >/dev/null 2>&1
# Guard the guard: a control that writes nothing would make every claim below
# vacuous (it would "prove" the defect by producing no data at all).
oldlines=$(wc -l < "$oldlog")
if [[ "$oldlines" -ge 2 ]]; then ok "control produced output ($oldlines lines) -- comparison is not vacuous"
else no "control wrote nothing ($oldlines lines) -- test proves NOTHING, fix the control"; fi
olddata=$(grep -cE '^20[0-9][0-9]-' "$oldlog")
oldnf=$(grep -E '^20[0-9][0-9]-' "$oldlog" | awk -F, '{print NF}' | head -1)
if [[ "$oldnf" == "9" ]]; then ok "control reproduces the defect: record truncated at NF=9 (splits mid-field-9)"
else no "control did NOT reproduce the split (NF=$oldnf, expected 9)"; fi
orphan=$(grep -cE '^[0-9]+,[0-9]+,' "$oldlog" | head -1)
tailnf=$(tail -1 "$oldlog" | awk -F, '{print NF}')
if [[ "$tailnf" == "10" ]]; then ok "control leaves a 10-column orphan continuation line"
else no "expected a 10-column orphan, got NF=$tailnf"; fi
echo "        control row 1: $(grep -E '^20[0-9][0-9]-' "$oldlog" | head -1)"
echo "        control row 2: $(tail -1 "$oldlog")"
rm -f "$oldlog"

echo "== 3. NEW script: one line, exactly 18 columns =="
log=$(mktemp)
PAPERCLIP_MEM_WATCH_LOG="$log" bash "$NEW" >/dev/null 2>&1
data=$(grep -cE '^20[0-9][0-9]-' "$log")
[[ "$data" == "1" ]] && ok "exactly 1 data row emitted" || no "expected 1 data row, got $data"
nf=$(grep -E '^20[0-9][0-9]-' "$log" | awk -F, '{print NF}')
[[ "$nf" == "18" ]] && ok "data row has 18 columns" || no "data row has $nf columns"
lines=$(wc -l < "$log")
[[ "$lines" == "2" ]] && ok "file is header + 1 row (2 lines, no orphan)" || no "file has $lines lines"
agent_col=$(grep -E '^20[0-9][0-9]-' "$log" | cut -d, -f9)
[[ "$agent_col" == "0" ]] && ok "agent_procs is the correct value 0 (not '0\\n0')" || no "agent_procs=$agent_col"
hdr=$(head -1 "$log" | awk -F, '{print NF}')
[[ "$hdr" == "18" ]] && ok "header still 18 columns (schema unchanged)" || no "header has $hdr columns"
rm -f "$log"

echo "== 4. csv_field neutralises newline/comma/empty (the general class) =="
# shellcheck disable=SC1090
csv_field() { local v=${1-}; v=${v%%$'\n'*}; v=${v//$'\r'/}; v=${v//,/;}
  v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}; printf '%s' "${v:-NA}"; }
[[ "$(csv_field $'0\n0')" == "0" ]] && ok "multi-line -> first line" || no "multi-line"
[[ "$(csv_field 'a,b')"   == "a;b" ]] && ok "comma -> ';' (cannot shift columns)" || no "comma"
[[ "$(csv_field '')"      == "NA"  ]] && ok "empty -> NA (cannot collapse a column)" || no "empty"

echo "== 5. tripwire refuses a short row rather than appending it =="
probe=$(mktemp); sed 's/^\(cap_deployed=yes\)$/\1/' "$NEW" > "$probe"
python3 - "$probe" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
s=s.replace('row+="${row:+,}$(csv_field "$f")"','row+="${row:+,}$(csv_field "$f")"\ndone\nrow="a,b,c"\nfor _ in x; do :')
open(p,'w').write(s)
PY
log=$(mktemp)
err=$(PAPERCLIP_MEM_WATCH_LOG="$log" bash "$probe" 2>&1 >/dev/null); rc=$?
if [[ $rc -ne 0 ]] && grep -q "REFUSING malformed row" <<<"$err" && [[ ! -s "$log" ]]; then
  ok "3-column row refused, nothing written, non-zero exit"
else no "tripwire did not fire (rc=$rc err=$err)"; fi
rm -f "$log" "$probe"

rm -rf "$SHIM"
echo; echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
