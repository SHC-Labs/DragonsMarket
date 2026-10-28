#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p .local/backups
archive=".local/backups/backend-$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary=$(mktemp .local/backups/.dump-XXXXXXXX)
trap 'rm -f "$temporary"' EXIT
# Credentials come from PostgreSQL environment or a protected .pgpass, never shell interpolation.
pg_dump --format=custom --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$archive"
sha256sum "$archive" > "$archive.sha256"
printf '%s\n' "$archive"
