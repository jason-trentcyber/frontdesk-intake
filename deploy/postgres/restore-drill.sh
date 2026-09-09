#!/usr/bin/env bash
# ADR-0016 acceptance 5: restore drill into a scratch DB on the live instance. Read-only on `frontdesk`.
set -euo pipefail
# Run from the repo root on a host with the admin kubeconfig (ADR-0016: drills are human actions over the tailnet).
cd "$(dirname "$0")/../.."
export KUBECONFIG="${KUBECONFIG:-infra/hetzner/kubeconfig}"
X="kubectl -n frontdesk exec sts/frontdesk-postgres --"
DUMP=$($X sh -c 'ls -t /backups/*.dump | head -1')
echo "dump: $DUMP ($($X stat -c %s "$DUMP") bytes)"
$X psql -U postgres -v ON_ERROR_STOP=1 -qc 'DROP DATABASE IF EXISTS frontdesk_restore_test;'
$X psql -U postgres -v ON_ERROR_STOP=1 -qc 'CREATE DATABASE frontdesk_restore_test OWNER frontdesk;'
$X pg_restore --no-owner -U postgres --dbname frontdesk_restore_test "$DUMP"
echo "--- extensions in restored DB:"
$X psql -U postgres -d frontdesk_restore_test -tAc "SELECT extname||' '||extversion FROM pg_extension WHERE extname IN ('vector','pgmq') ORDER BY 1"
echo "--- object counts (tables/functions in non-system schemas), source vs restored:"
Q="SELECT (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema'))||' tables, '||(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pgmq')||' pgmq functions'"
echo "source:   $($X psql -U postgres -d frontdesk -tAc "$Q")"
echo "restored: $($X psql -U postgres -d frontdesk_restore_test -tAc "$Q")"
$X psql -U postgres -qc 'DROP DATABASE frontdesk_restore_test;'
echo "--- scratch DB dropped; databases now:"
$X psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname NOT LIKE 'template%' ORDER BY 1"
echo "RESTORE DRILL OK $(date -u +%FT%TZ) $DUMP"
