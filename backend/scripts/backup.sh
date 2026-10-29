#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
# pg_dump falls back to a local default server and a database named after the user. Require the target explicitly, or this
# can dump the wrong database and still report success.
: "${PGHOST:?set PGHOST, PGPORT, PGDATABASE and PGUSER to the database to back up}"
: "${PGPORT:?set PGPORT}"
: "${PGDATABASE:?set PGDATABASE}"
: "${PGUSER:?set PGUSER}"
keep=${BACKUP_KEEP:-14}
mkdir -p .local/backups
archive=".local/backups/backend-$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary=$(mktemp .local/backups/.dump-XXXXXXXX)
trap 'rm -f "$temporary"' EXIT
# Credentials come from PostgreSQL environment or a protected .pgpass, never shell interpolation.
pg_dump --format=custom --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$archive"
sha256sum "$archive" > "$archive.sha256"
# Keep the newest $keep archives and their checksums.
ls -1t .local/backups/backend-*.dump | tail -n +"$((keep + 1))" | while read -r old; do rm -f -- "$old" "$old.sha256"; done
printf '%s\n' "$archive"
