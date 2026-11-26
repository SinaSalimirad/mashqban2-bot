#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/backup.sh BACKUP_DIRECTORY" >&2
  exit 2
fi

backup_directory=$1
mkdir -p "$backup_directory"
backup_directory=$(cd "$backup_directory" && pwd)
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
database_archive="$backup_directory/mashqban-$backup_stamp.pgcustom"
files_archive="$backup_directory/mashqban-$backup_stamp.files.tar.gz"
checksums="$backup_directory/mashqban-$backup_stamp.sha256"

if [ -e "$database_archive" ] || [ -e "$files_archive" ] || [ -e "$checksums" ]; then
  echo "Backup destination already exists" >&2
  exit 1
fi

app_was_running=$(docker compose ps --status running -q app)

cleanup() {
  rm -f "$database_archive.tmp" "$files_archive.tmp" "$checksums.tmp"
  if [ -n "$app_was_running" ]; then
    docker compose up -d app >/dev/null
  fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ -n "$app_was_running" ]; then
  docker compose stop app
fi

if ! docker compose exec -T db pg_dump -U mashqban -Fc mashqban > "$database_archive.tmp"; then
  rm -f "$database_archive.tmp"
  exit 1
fi
if ! docker compose run --rm --no-deps --entrypoint tar app \
  -C /var/lib/mashqban/files -czf - . > "$files_archive.tmp"; then
  rm -f "$database_archive.tmp" "$files_archive.tmp"
  exit 1
fi

mv "$database_archive.tmp" "$database_archive"
mv "$files_archive.tmp" "$files_archive"
(cd "$backup_directory" && sha256sum "$(basename "$database_archive")" \
  "$(basename "$files_archive")") > "$checksums.tmp"
mv "$checksums.tmp" "$checksums"
echo "Backup written to $database_archive, $files_archive, and $checksums"
