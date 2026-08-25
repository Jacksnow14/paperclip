#!/usr/bin/env bash
# AUR-4338 fire 14 -- regression suite for rule1.sh (the conjunction gate).
#
# Standing requirement, same as swap-trend.test.sh and oom-clause3.test.sh:
# this suite must pass BEFORE any fire trusts rule1.sh's verdict. A green suite
# is what makes the verdict evidence rather than output.
#
# The suite proves the gate discriminates in BOTH directions -- it must be able
# to PASS on a genuinely green box (fire 8's rule: a check that can never clear
# is as broken as one that never fires) and must refuse on every single-clause
# failure, on every failure-to-measure, and across a mid-sweep restart.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
RULE1="./rule1.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
passed=0; failed=0

# A sampler row is a positional CSV; $15 is cp_since and $NF is cap_deployed.
mklog() { # $1=path $2=cap_deployed $3=cp_since
  printf 'ts,mem_avail_mb,mem_used_mb,swap_used_mb,swap_free_mb,swap_total_mb,load1,oom_5min,agent_procs,busy_agents,max_per_agent,build_rss_mb,db_restarts,cp_pid,cp_since,cp_oom_adj,release,cap_deployed\n' > "$1"
  printf '2026-08-06T02:38:08Z,3718,3364,2186,5909,8095,15.04,0,2,2,1,0,0,526527,%s,-800,673b5ede2965,%s\n' "$3" "$2" >> "$1"
}
mkgate() { printf '#!/usr/bin/env bash\necho "verdict=%s"\nexit %s\n' "$2" "$3" > "$1"; chmod +x "$1"; }

run_case() { # $1=name $2=expected_verdict $3=expected_exit $4=note ; env preset by caller
  local out rc
  out=$("$RULE1" 2>&1); rc=$?
  local got
  got=$(printf '%s\n' "$out" | grep -oE 'verdict=[A-Z0-9_]+' | tail -1 | cut -d= -f2)
  if [ "$got" = "$2" ] && [ "$rc" -eq "$3" ]; then
    printf '  PASS  %-22s %-14s exit=%s  %s\n' "$1" "$got" "$rc" "$4"; passed=$((passed+1))
  else
    printf '  FAIL  %-22s got %s/exit=%s, want %s/exit=%s  %s\n' "$1" "$got" "$rc" "$2" "$3" "$4"; failed=$((failed+1))
  fi
}

setup() { # $1=cap $2=c2exit $3=c3exit $4=c4status  (cp_since fixed unless overridden)
  mklog "$TMP/mem.log" "$1" "2026-08-05T18:40:59"
  mkgate "$TMP/swap-trend.sh" "$([ "$2" -eq 0 ] && echo SATISFIED || echo INDETERMINATE)" "$2"
  mkgate "$TMP/oom-clause3.sh" "$([ "$3" -eq 0 ] && echo CLEAN || echo KILLS_PRESENT)" "$3"
  export RULE1_MEM_LOG="$TMP/mem.log" RULE1_SWAP_TREND="$TMP/swap-trend.sh" \
         RULE1_OOM_C3="$TMP/oom-clause3.sh" RULE1_CLAUSE4_FIXTURE="$4"
}

echo "== 1. the gate must be able to PASS (a check that can never clear is as broken as one that never fires) =="
setup yes 0 0 done
run_case all_four_green RULE1_MET 0 "the only state that may close the P0"

echo "== 2. every single clause must be able to block, alone =="
setup no  0 0 done; run_case clause1_red RULE1_NOT_MET 1 "cap_deployed=no (defect 11 inverted this with no code change)"
setup yes 1 0 done; run_case clause2_red RULE1_NOT_MET 1 "swap trend INDETERMINATE -- the live fire-14 state"
setup yes 0 1 done; run_case clause3_red RULE1_NOT_MET 1 "global OOM kills in 24h -- the fire-12/13 backstop"
setup yes 0 0 blocked; run_case clause4_red RULE1_NOT_MET 1 "AUR-4118 not done"

echo "== 3. a failure to MEASURE is not a pass (defect 2, ported to the conjunction) =="
setup yes 0 3 done; run_case clause3_unreadable UNKNOWN 3 "journal unreadable must not read as a clean box"
setup yes 0 0 TRANSPORT_FAIL; run_case clause4_unreachable UNKNOWN 3 "cannot reach board != blocker is done"
setup yes 0 0 done; export RULE1_SWAP_TREND="$TMP/does-not-exist.sh"
run_case gate_missing UNKNOWN 3 "a missing sub-gate must not silently drop a clause"

echo "== 4. the readings must describe ONE box-state (confound 1, applied to the conjunction) =="
setup yes 0 0 done
# clause 3's gate rewrites the log with a NEW cp_since: a restart mid-sweep.
printf '#!/usr/bin/env bash\nprintf "2026-08-06T02:40:00Z,1,1,1,1,1,1,0,0,0,0,0,0,1,2026-08-06T02:39:00,-800,x,yes\\n" >> "%s"\necho "verdict=CLEAN"\nexit 0\n' "$TMP/mem.log" > "$TMP/oom-clause3.sh"
chmod +x "$TMP/oom-clause3.sh"
run_case restart_mid_sweep UNKNOWN 3 "clauses measured across a restart do not describe one box"

echo "== 5. MUTATION: a clause pass must NOT carry forward -- the defect this file exists for =="
setup yes 0 0 done
out1=$("$RULE1" 2>&1); rc1=$?
# Same invocation shape, but clause 2 is now live-red. Fire 13 read SATISFIED and
# fire 14 read INDETERMINATE inside ONE epoch: a prior green must buy nothing.
mkgate "$TMP/swap-trend.sh" INDETERMINATE 1
out2=$("$RULE1" 2>&1); rc2=$?
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 1 ]; then
  printf '  PASS  %-22s %-14s exit=%s  %s\n' "stale_green_not_reused" "RULE1_NOT_MET" "$rc2" "prior MET does not survive a live clause-2 flip"
  passed=$((passed+1))
else
  printf '  FAIL  %-22s first=%s second=%s (want 0 then 1)  %s\n' "stale_green_not_reused" "$rc1" "$rc2" "carry-forward detected"
  failed=$((failed+1))
fi

echo "== 6. clause 4 must survive a SLOW board, and the timeout must be load-bearing (defect 16) =="
# A local endpoint that answers correctly but slowly. This is the live 2026-08-06
# condition in miniature: the board's single-issue route took 43.5s against a
# 20s budget, so clause 4 read TRANSPORT_FAIL -> UNKNOWN on a box where AUR-4118
# was genuinely `done`. Fail-closed, but UNSATISFIABLE -- rule 1 could never
# return exit 0, which re-arms this self-terminating watch forever (defect 1's
# shape). The delay here is 12s rather than 43s only to keep the suite quick;
# what is proven is the DIRECTION, and the production constant of 120s is
# justified against the measured 44.4s maximum in rule1.sh's comment.
cat > "$TMP/slow-api.py" <<'PY'
import http.server, json, sys, time
DELAY = float(sys.argv[1]); PORTFILE = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(DELAY)
        b = json.dumps({"identifier": "AUR-4118", "status": "done"}).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers(); self.wfile.write(b)
        except (BrokenPipeError, ConnectionResetError):
            # Expected in the mutation case: the tightened budget makes curl hang
            # up mid-response. That IS the case under test, not a fixture fault.
            pass
    def log_message(self, *a): pass
    def handle_one_request(self):
        try:
            http.server.BaseHTTPRequestHandler.handle_one_request(self)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORTFILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$TMP/slow-api.py" 12 "$TMP/port" & SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 100); do [ -s "$TMP/port" ] && break; sleep 0.1; done
PORT=$(cat "$TMP/port" 2>/dev/null)

if [ -z "$PORT" ]; then
  printf '  FAIL  %-22s slow-api fixture never bound a port\n' "slow_board_ok"; failed=$((failed+1))
  printf '  FAIL  %-22s slow-api fixture never bound a port\n' "mutation_timeout"; failed=$((failed+1))
else
  # Clauses 1-3 green by fixture; clause 4 goes over the REAL curl path.
  setup yes 0 0 done
  unset RULE1_CLAUSE4_FIXTURE
  export RULE1_API_BASE="http://127.0.0.1:$PORT"
  run_case slow_board_ok RULE1_MET 0 "a slow-but-answering board is measured, not written off as unreachable"

  # MUTATION: revert the budget on a COPY. Same server, same series, and the
  # false UNKNOWN comes straight back -- so 120s is what makes clause 4 reachable.
  sed 's/^CLAUSE4_TIMEOUT_S=120$/CLAUSE4_TIMEOUT_S=5/' "$RULE1" > "$TMP/rule1-tight.sh"
  chmod +x "$TMP/rule1-tight.sh"
  if ! grep -q '^CLAUSE4_TIMEOUT_S=5$' "$TMP/rule1-tight.sh"; then
    printf '  FAIL  %-22s mutation did not apply -- constant was renamed?\n' "mutation_timeout"; failed=$((failed+1))
  else
    mut_out=$("$TMP/rule1-tight.sh" 2>&1); mut_rc=$?
    mut_v=$(printf '%s\n' "$mut_out" | grep -oE 'verdict=[A-Z0-9_]+' | tail -1 | cut -d= -f2)
    if [ "$mut_v" = "UNKNOWN" ] && [ "$mut_rc" -eq 3 ]; then
      printf '  PASS  %-22s %-14s exit=%s  %s\n' "mutation_timeout" "$mut_v" "$mut_rc" \
        "budget cut to 5s -> the live defect-16 false UNKNOWN returns; 120s is load-bearing"
      passed=$((passed+1))
    else
      printf '  FAIL  %-22s got %s/exit=%s, want UNKNOWN/exit=3  timeout is not load-bearing\n' \
        "mutation_timeout" "$mut_v" "$mut_rc"; failed=$((failed+1))
    fi
  fi

  echo "== 7. a substituted run must DECLARE itself (fire 15: unforgeability was prose) =="
  # RULE1_CLAUSE4_FIXTURE is still unset here and RULE1_API_BASE is set, so the
  # line must list the latter and NOT the former. That is what distinguishes a
  # disclosure that tracks real state from a constant string.
  d_out=$("$RULE1" 2>&1)
  d_line=$(printf '%s\n' "$d_out" | grep -oE 'overrides_active=[A-Za-z0-9_,]*' | head -1)
  if printf '%s' "$d_line" | grep -q 'RULE1_API_BASE' \
     && ! printf '%s' "$d_line" | grep -q 'RULE1_CLAUSE4_FIXTURE' \
     && ! printf '%s' "$d_line" | grep -q 'none'; then
    printf '  PASS  %-22s %-14s        %s\n' "overrides_declared" "declared" \
      "lists the seams actually in use, omits the one that is not"
    passed=$((passed+1))
  else
    printf '  FAIL  %-22s got "%s"  disclosure does not track real state\n' "overrides_declared" "$d_line"
    failed=$((failed+1))
  fi
  kill $SRV_PID 2>/dev/null
fi

echo
echo "passed=$passed failed=$failed"
if [ "$failed" -eq 0 ]; then
  echo "ALL PASS -- conjunction is measured live in one invocation, blocks on any single clause, refuses to guess, and cannot reuse a stale pass."
  exit 0
fi
exit 1
