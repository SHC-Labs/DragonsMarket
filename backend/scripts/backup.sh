#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
extension=dump
if [[ $# == 1 && $1 == --encrypt ]]; then
  : "${BACKUP_AGE_RECIPIENTS_FILE:?set BACKUP_AGE_RECIPIENTS_FILE to the approved public recipients file}"
  [[ -f "$BACKUP_AGE_RECIPIENTS_FILE" && -r "$BACKUP_AGE_RECIPIENTS_FILE" ]] || exit 1
  BACKUP_AGE_RECIPIENTS_FILE=$(realpath -- "$BACKUP_AGE_RECIPIENTS_FILE")
  extension=dump.age
elif [[ $# != 0 ]]; then
  printf '%s\n' 'Usage: backup.sh [--encrypt]' >&2
  exit 1
fi
# pg_dump falls back to a local default server and a database named after the user. Require the target explicitly, or this
# can dump the wrong database and still report success.
: "${PGHOST:?set PGHOST, PGPORT, PGDATABASE and PGUSER to the database to back up}"
: "${PGPORT:?set PGPORT}"
: "${PGDATABASE:?set PGDATABASE}"
: "${PGUSER:?set PGUSER}"
keep=${BACKUP_KEEP:-14}
if [[ ! "$keep" =~ ^[1-9][0-9]{0,2}$ ]]; then
  printf '%s\n' 'BACKUP_KEEP must be an integer between 1 and 999' >&2
  exit 1
fi
directory=${BACKUP_DIR:-.local/backups}
mkdir -p -- "$directory"
if [[ -L "$directory" || ! -O "$directory" || $(stat -c %a -- "$directory") != 700 ]]; then
  printf '%s\n' 'Backup directory must be owned by this user with mode 700 and not be a symlink' >&2
  exit 1
fi
directory=$(realpath -- "$directory")
exec 9>"$directory/.backup.lock"
flock -n 9 || { printf '%s\n' 'Another backup is running in this directory' >&2; exit 1; }
temporary=$(mktemp "$directory/.dump-XXXXXXXX")
trap 'rm -f -- "$temporary" "$temporary.sha256"' EXIT
archive="$directory/backend-$(date -u +%Y%m%dT%H%M%SZ)-${temporary##*-}.$extension"
# Credentials come from PostgreSQL environment or a protected .pgpass, never shell interpolation.
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}
if [[ $extension == dump.age ]]; then
  pg_dump --no-password --format=custom --no-owner --no-acl |
    age --encrypt --recipients-file "$BACKUP_AGE_RECIPIENTS_FILE" --output "$temporary"
else
  pg_dump --no-password --format=custom --no-owner --no-acl --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
fi
digest=$(sha256sum < "$temporary")
printf '%s  %s\n' "${digest%% *}" "${archive##*/}" > "$temporary.sha256"
mv -- "$temporary" "$archive"
mv -- "$temporary.sha256" "$archive.sha256"
# Keep the newest $keep archives and their checksums.
find "$directory" -maxdepth 1 -type f -name "backend-*.$extension" -printf '%T@ %p\0' |
  sort -z -nr | tail -z -n +"$((keep + 1))" | cut -z -d ' ' -f 2- |
  while IFS= read -r -d '' old; do rm -f -- "$old" "$old.sha256"; done
printf '%s\n' "$archive"
