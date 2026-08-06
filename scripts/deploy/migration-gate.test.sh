#!/usr/bin/env bash
# AUR-5019: FIRE/PASS proof for migration-gate.mjs against REAL Postgres.
#
# The verification bar from the incident (2026-08-05, 0098 + 0099): a guard is
# only proven by a passing case AND a failing case. This suite replays both
# observed outage modes with their ACTUAL pre-fix SQL against fixture DBs that
# reproduce the live states that broke production, and the merged (fixed)
# migrations against the same states:
#
#   FIRE 0098-mode  pre-fix CREATE UNIQUE INDEX over duplicate rows  -> BLOCK(2)
#   FIRE 0099-mode  raw re-execution against a drifted DB (table
#                   exists, no journal row, reconciliation cannot
#                   prove the prefix)                                -> BLOCK(2)
#   PASS 0098-fixed merged convergence + IF NOT EXISTS, same dups    -> PASS(0)
#   PASS 0099-fixed merged idempotent DDL, same drifted table        -> PASS(0)
#   PASS clean      a routine additive migration                     -> PASS(0)
#   PASS fast-path  no pending migrations                            -> PASS(0)
#
# Plus the AUR-4187 lesson (a merged detector that watched nothing): static
# asserts that both deploy scripts invoke the gate BEFORE their symlink flip.
#
# Hermetic: its own throwaway "live" Postgres cluster (embedded-postgres
# binaries from packages/db's node_modules), fixture db-dists copied under
# packages/db so node module resolution works, everything removed on exit.
# The real control-plane DB is never touched.
#
# Run: bash scripts/deploy/migration-gate.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
GATE="$SCRIPT_DIR/migration-gate.mjs"
NODE=${PAPERCLIP_DEPLOY_NODE:-node}
DB_PKG=${PAPERCLIP_GATE_TEST_DB_PKG:-$(cd "$SCRIPT_DIR/../.." && pwd)/packages/db}
DB_DIST="$DB_PKG/dist"

[[ -f "$GATE" ]] || { echo "missing $GATE" >&2; exit 1; }
[[ -f "$DB_DIST/client.js" && -f "$DB_DIST/backup-lib.js" ]] || {
  echo "SKIP: $DB_DIST not built (pnpm --filter @paperclipai/db build)" >&2; exit 0; }
NATIVE=$("$NODE" -e '
const { createRequire } = require("module");
const { dirname, resolve } = require("path");
const cr = createRequire(process.argv[1] + "/package.json");
const cr2 = createRequire(cr.resolve("embedded-postgres"));
// The package exports only its main entry (dist/index.js); derive the package
// root from it — ./package.json is not an exported subpath.
console.log(resolve(dirname(cr2.resolve("@embedded-postgres/linux-x64")), ".."));
' "$DB_PKG" 2>/dev/null) || { echo "SKIP: embedded-postgres not installed under $DB_PKG" >&2; exit 0; }
PGBIN="$NATIVE/native/bin"
[[ -x "$PGBIN/initdb" && -x "$PGBIN/pg_ctl" ]] || { echo "SKIP: no initdb/pg_ctl in $PGBIN" >&2; exit 0; }
export LD_LIBRARY_PATH="$NATIVE/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

TMP=$(mktemp -d)
# Fixture db-dists must live under packages/db: their client.js resolves
# `postgres` / `drizzle-orm` by walking up to packages/db/node_modules.
FIXROOT=$(mktemp -d "$DB_PKG/.gate-test-fixtures.XXXXXX")
LIVE_DIR="$TMP/live-pg"
LIVE_PORT=$(( 55200 + RANDOM % 500 ))
SOCK="$TMP/sock"; mkdir -p "$SOCK"

cleanup() {
  "$PGBIN/pg_ctl" -D "$LIVE_DIR" -m immediate stop >/dev/null 2>&1
  rm -rf "$TMP" "$FIXROOT"
}
trap cleanup EXIT

FAILURES=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n     %s\n' "$1" "$2"; FAILURES=$(( FAILURES + 1 )); }

# --- the throwaway "live" cluster ---------------------------------------------
"$PGBIN/initdb" -D "$LIVE_DIR" -U paperclip -A trust --encoding=UTF8 --locale=C >/dev/null 2>"$TMP/initdb.err" \
  || { cat "$TMP/initdb.err" >&2; echo "FATAL: initdb failed" >&2; exit 1; }
"$PGBIN/pg_ctl" -w -D "$LIVE_DIR" -l "$TMP/live-pg.log" \
  -o "-p $LIVE_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCK" start >/dev/null \
  || { tail -20 "$TMP/live-pg.log" >&2; echo "FATAL: live fixture cluster failed to start" >&2; exit 1; }

pgq() { # $1=db-url $2=sql  (multi-statement OK, no CREATE DATABASE inside)
  "$NODE" -e '
const { createRequire } = require("module");
const postgres = createRequire(process.argv[1] + "/package.json")("postgres");
const sql = postgres(process.argv[2], { max: 1, onnotice: () => {} });
sql.unsafe(process.argv[3])
  .then(() => sql.end())
  .catch((e) => { console.error(e.message); process.exit(1); });
' "$DB_PKG" "$1" "$2"
}

url_for() { echo "postgres://paperclip:paperclip@127.0.0.1:$LIVE_PORT/$1"; }
ADMIN_URL=$(url_for postgres)

hash_of() {
  "$NODE" -e '
const { createHash } = require("crypto");
const { readFileSync } = require("fs");
console.log(createHash("sha256").update(readFileSync(process.argv[1], "utf8")).digest("hex"));
' "$1"
}

# make_fixture <name>: a candidate "release" whose db dist is a copy of the real
# built dist with its OWN migrations dir. Caller then writes migrations into
# $FIXROOT/<name>/dist/migrations.
make_fixture() {
  local d="$FIXROOT/$1"
  mkdir -p "$d"
  cp -r "$DB_DIST" "$d/dist"
  rm -rf "$d/dist/migrations"
  mkdir -p "$d/dist/migrations/meta"
  printf '{"version":"7","dialect":"postgresql","entries":[]}\n' > "$d/dist/migrations/meta/_journal.json"
  echo "$d"
}

run_gate() { # $1=fixture dir $2=live db name; stdout+stderr to $TMP/gate.out
  "$NODE" "$GATE" --release "$1" --db-dist "$1/dist" --live-url "$(url_for "$2")" \
    --work-dir "$TMP" > "$TMP/gate.out" 2>&1
}

# Shared fixture SQL -----------------------------------------------------------
# The live-state shape of the 0098 outage: routing_rationale rows with duplicate
# (company_id, title) groups, all accepted / not superseded / not deleted.
MLR_BASE='CREATE TABLE "memory_local_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "title" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '"'"'{}'"'"',
  "review_state" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "superseded_by_record_id" uuid,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);'
seed_journal() { # $1=db $2=hash-of-0001
  pgq "$(url_for "$1")" "CREATE SCHEMA \"drizzle\";
CREATE TABLE \"drizzle\".\"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO \"drizzle\".\"__drizzle_migrations\" (hash, created_at) VALUES ('$2', 1000);"
}
seed_duplicates() { # $1=db — 2 duplicate groups + 1 clean row, the 0098 shape
  pgq "$(url_for "$1")" "INSERT INTO \"memory_local_records\" (\"company_id\", \"title\", \"metadata\", \"review_state\", \"created_at\") VALUES
  ('11111111-1111-1111-1111-111111111111', 'routing/AUR-4140', '{\"category\": \"routing_rationale\"}', 'accepted', now() - interval '2 hour'),
  ('11111111-1111-1111-1111-111111111111', 'routing/AUR-4140', '{\"category\": \"routing_rationale\"}', 'accepted', now() - interval '1 hour'),
  ('11111111-1111-1111-1111-111111111111', 'routing/AUR-2756', '{\"category\": \"routing_rationale\"}', 'accepted', now() - interval '3 hour'),
  ('11111111-1111-1111-1111-111111111111', 'routing/AUR-2756', '{\"category\": \"routing_rationale\"}', 'accepted', now()),
  ('22222222-2222-2222-2222-222222222222', 'routing/AUR-1500', '{\"category\": \"routing_rationale\"}', 'accepted', now());"
}

# The PRE-FIX SQL, verbatim from git history (673b5ede2^), the statements that
# took production down. Kept inline so the FIRE cases cannot drift toward the
# fixed files.
PREFIX_0098='CREATE UNIQUE INDEX "memory_local_records_routing_rationale_title_uq" ON "memory_local_records" USING btree ("company_id","title") WHERE "memory_local_records"."metadata"->>'"'"'category'"'"' = '"'"'routing_rationale'"'"'
          and "memory_local_records"."review_state" = '"'"'accepted'"'"'
          and "memory_local_records"."revoked_at" is null
          and "memory_local_records"."superseded_by_record_id" is null
          and "memory_local_records"."deleted_at" is null;'

GMAIL_TABLE_BODY='(
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"recipient" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
)'
PREFIX_0099="CREATE TABLE \"gmail_outbound_records\" $GMAIL_TABLE_BODY;
--> statement-breakpoint
ALTER TABLE \"gmail_outbound_records\" ADD CONSTRAINT \"gmail_outbound_records_company_id_companies_id_fk\" FOREIGN KEY (\"company_id\") REFERENCES \"public\".\"companies\"(\"id\") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX \"gmail_outbound_message_uq\" ON \"gmail_outbound_records\" USING btree (\"company_id\",\"mailbox\",\"gmail_message_id\");
--> statement-breakpoint
CREATE INDEX \"gmail_outbound_thread_idx\" ON \"gmail_outbound_records\" USING btree (\"company_id\",\"mailbox\",\"gmail_thread_id\");"

# ================================================================================
# FIRE 0098-mode: pre-fix unique index + the duplicate rows that existed on
# 2026-08-05 -> the replay must ABORT and the gate must exit 2.
FIX=$(make_fixture fire98)
printf '%s\n' "$MLR_BASE" > "$FIX/dist/migrations/0001_base.sql"
printf '%s\n' "$PREFIX_0098" > "$FIX/dist/migrations/0002_uq.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE fire98'
seed_journal fire98 "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for fire98)" "$MLR_BASE"
seed_duplicates fire98
run_gate "$FIX" fire98; rc=$?
if [[ "$rc" == 2 ]] && grep -q "MIGRATION-GATE: BLOCK" "$TMP/gate.out" && grep -q "0002_uq.sql" "$TMP/gate.out"; then
  ok "FIRE 0098-mode: pre-fix unique index over live duplicates -> BLOCK (exit 2)"
else
  fail "FIRE 0098-mode: pre-fix unique index over live duplicates -> BLOCK (exit 2)" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi
grep -qi "duplicate" "$TMP/gate.out" \
  && ok "FIRE 0098-mode: the block names the duplicate-key abort (actionable page)" \
  || fail "FIRE 0098-mode: the block names the duplicate-key abort (actionable page)" "$(tail -5 "$TMP/gate.out")"

# ================================================================================
# FIRE 0099-mode: the drifted-DB raw re-execution. The live DB already HAS
# gmail_outbound_records (hand-created, no journal row); the pending pre-fix
# file re-executes raw because the reconciliation branch cannot prove the whole
# migration applied (constraint + indexes are missing), and its bare CREATE
# TABLE aborts — exactly the first post-deploy boot on 2026-08-05.
FIX=$(make_fixture fire99)
printf 'CREATE TABLE "companies" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "name" text NOT NULL);\n' > "$FIX/dist/migrations/0001_base.sql"
printf '%s\n' "$PREFIX_0099" > "$FIX/dist/migrations/0002_gmail.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE fire99'
seed_journal fire99 "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for fire99)" "CREATE TABLE \"companies\" (\"id\" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, \"name\" text NOT NULL);
CREATE TABLE \"gmail_outbound_records\" $GMAIL_TABLE_BODY;"
run_gate "$FIX" fire99; rc=$?
if [[ "$rc" == 2 ]] && grep -q "MIGRATION-GATE: BLOCK" "$TMP/gate.out"; then
  ok "FIRE 0099-mode: raw re-execution against a drifted DB -> BLOCK (exit 2)"
else
  fail "FIRE 0099-mode: raw re-execution against a drifted DB -> BLOCK (exit 2)" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi

# ================================================================================
# PASS 0098-fixed: the MERGED migration (converge, then IF NOT EXISTS index)
# over the SAME duplicate state must clear. A gate that can never clear is as
# broken as one that never fires.
FIX=$(make_fixture pass98)
printf '%s\n' "$MLR_BASE" > "$FIX/dist/migrations/0001_base.sql"
cp "$DB_DIST/migrations/0098_memory_local_records_routing_rationale_title_uq.sql" "$FIX/dist/migrations/0002_uq_fixed.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE pass98'
seed_journal pass98 "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for pass98)" "$MLR_BASE"
seed_duplicates pass98
run_gate "$FIX" pass98; rc=$?
if [[ "$rc" == 0 ]] && grep -q "MIGRATION-GATE: PASS" "$TMP/gate.out"; then
  ok "PASS 0098-fixed: merged convergence migration clears over the same duplicates"
else
  fail "PASS 0098-fixed: merged convergence migration clears over the same duplicates" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi

# ================================================================================
# PASS 0099-fixed: the MERGED idempotent 0099 over the SAME drifted table.
FIX=$(make_fixture pass99)
printf 'CREATE TABLE "companies" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "name" text NOT NULL);\n' > "$FIX/dist/migrations/0001_base.sql"
cp "$DB_DIST/migrations/0099_gmail_outbound_records.sql" "$FIX/dist/migrations/0002_gmail_fixed.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE pass99'
seed_journal pass99 "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for pass99)" "CREATE TABLE \"companies\" (\"id\" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, \"name\" text NOT NULL);
CREATE TABLE \"gmail_outbound_records\" $GMAIL_TABLE_BODY;"
run_gate "$FIX" pass99; rc=$?
if [[ "$rc" == 0 ]] && grep -q "MIGRATION-GATE: PASS" "$TMP/gate.out"; then
  ok "PASS 0099-fixed: merged idempotent migration clears over the same drift"
else
  fail "PASS 0099-fixed: merged idempotent migration clears over the same drift" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi

# ================================================================================
# PASS clean: a routine additive migration over populated live data.
FIX=$(make_fixture clean)
printf '%s\n' "$MLR_BASE" > "$FIX/dist/migrations/0001_base.sql"
cat > "$FIX/dist/migrations/0002_routine.sql" <<'SQL'
CREATE TABLE "gate_probe_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "gate_probe" text;
--> statement-breakpoint
CREATE INDEX "gate_probe_notes_body_idx" ON "gate_probe_notes" USING btree ("body");
SQL
pgq "$ADMIN_URL" 'CREATE DATABASE cleanpass'
seed_journal cleanpass "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for cleanpass)" "$MLR_BASE"
seed_duplicates cleanpass
run_gate "$FIX" cleanpass; rc=$?
if [[ "$rc" == 0 ]] && grep -q "MIGRATION-GATE: PASS" "$TMP/gate.out"; then
  ok "PASS clean: a routine additive migration clears (no false fire)"
else
  fail "PASS clean: a routine additive migration clears (no false fire)" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi

# ================================================================================
# PASS fast-path: nothing pending -> PASS without snapshotting anything.
FIX=$(make_fixture uptodate)
printf '%s\n' "$MLR_BASE" > "$FIX/dist/migrations/0001_base.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE uptodate'
seed_journal uptodate "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for uptodate)" "$MLR_BASE"
run_gate "$FIX" uptodate; rc=$?
if [[ "$rc" == 0 ]] && grep -q "no pending migrations" "$TMP/gate.out"; then
  ok "PASS fast-path: up-to-date live DB passes without a snapshot"
else
  fail "PASS fast-path: up-to-date live DB passes without a snapshot" "rc=$rc out=$(tail -5 "$TMP/gate.out")"
fi

# ================================================================================
# R2 (review): the timeout watchdog must CLEAN UP, not just exit —
# process.exit() skips finally blocks, so this asserts the explicit cleanup
# path. And a workdir leaked by a SIGKILLed run must be swept at next start.
FIX=$(make_fixture timeoutcase)
printf '%s\n' "$MLR_BASE" > "$FIX/dist/migrations/0001_base.sql"
printf 'CREATE TABLE "gate_timeout_probe" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL);\n' > "$FIX/dist/migrations/0002_probe.sql"
pgq "$ADMIN_URL" 'CREATE DATABASE timeoutcase'
seed_journal timeoutcase "$(hash_of "$FIX/dist/migrations/0001_base.sql")"
pgq "$(url_for timeoutcase)" "$MLR_BASE"
WD="$TMP/wd-timeout"; mkdir -p "$WD"
STALE="$WD/paperclip-migration-gate-STALELEAK"; mkdir -p "$STALE"
touch -d '2 hours ago' "$STALE"
# Timeout 0 = the watchdog fires at the first await, deterministically before
# any real work completes (a small positive value raced the gate and lost on a
# warm page cache). The workdir already exists by then, so the leak check is
# meaningful.
PAPERCLIP_MIGRATION_GATE_TIMEOUT_SEC=0 "$NODE" "$GATE" --release "$FIX" --db-dist "$FIX/dist" \
  --live-url "$(url_for timeoutcase)" --work-dir "$WD" > "$TMP/gate.out" 2>&1; rc=$?
leftovers=$(find "$WD" -maxdepth 1 -name 'paperclip-migration-gate-*' 2>/dev/null | wc -l)
if [[ "$rc" == 3 ]] && grep -q "timed out after 0s" "$TMP/gate.out" && [[ "$leftovers" == 0 ]]; then
  ok "R2: forced timeout exits 3 AND removes its workdir (no leak)"
else
  fail "R2: forced timeout exits 3 AND removes its workdir (no leak)" \
    "rc=$rc leftovers=$leftovers out=$(tail -3 "$TMP/gate.out")"
fi
[[ ! -d "$STALE" ]] \
  && ok "R2: stale workdir from a killed run is swept at gate start" \
  || fail "R2: stale workdir from a killed run is swept at gate start" "$STALE survived the sweep"

# ================================================================================
# Armed-guard asserts (AUR-4187: a merged detector that watched nothing).
# The call site must exist and PRECEDE the symlink flip in both deploy scripts.
ad_gate=$(grep -n 'MIGRATION_GATE_CMD --release' "$SCRIPT_DIR/auto-deploy.sh" | head -1 | cut -d: -f1)
ad_flip=$(grep -n 'repoint_current "\$rel12"' "$SCRIPT_DIR/auto-deploy.sh" | head -1 | cut -d: -f1)
if [[ -n "$ad_gate" && -n "$ad_flip" ]] && (( ad_gate < ad_flip )); then
  ok "armed: auto-deploy.sh invokes the gate before repoint_current (line $ad_gate < $ad_flip)"
else
  fail "armed: auto-deploy.sh invokes the gate before repoint_current" "gate_line=$ad_gate flip_line=$ad_flip"
fi
sd_gate=$(grep -n 'migration-gate.mjs' "$SCRIPT_DIR/safe-deploy.sh" | head -1 | cut -d: -f1)
sd_flip=$(grep -n 'ln -sfn "releases/\$SHA12"' "$SCRIPT_DIR/safe-deploy.sh" | head -1 | cut -d: -f1)
if [[ -n "$sd_gate" && -n "$sd_flip" ]] && (( sd_gate < sd_flip )); then
  ok "armed: safe-deploy.sh invokes the gate before the activate flip (line $sd_gate < $sd_flip)"
else
  fail "armed: safe-deploy.sh invokes the gate before the activate flip" "gate_line=$sd_gate flip_line=$sd_flip"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "migration-gate suite: all cases passed"
  exit 0
fi
echo "migration-gate suite: $FAILURES case(s) failed"
exit 1
