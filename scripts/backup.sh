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

if [ -e "$database_archive" ] || [ -e "$files_archive" ]; then
  echo "Backup destination already exists" >&2
  exit 1
fi

restart_app() {
  docker compose up -d app >/dev/null
}

trap restart_app EXIT
trap 'exit 1' HUP INT TERM
docker compose stop app

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
echo "Backup written to $database_archive and $files_archive"
