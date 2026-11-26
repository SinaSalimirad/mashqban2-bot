#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/verify-backup.sh CHECKSUM_FILE" >&2
  exit 2
fi

checksum_file=$1
backup_directory=$(cd "$(dirname "$checksum_file")" && pwd)
checksum_name=$(basename "$checksum_file")

case "$checksum_name" in
  mashqban-*.sha256) ;;
  *) echo "Unexpected checksum filename" >&2; exit 1 ;;
esac

cd "$backup_directory"
sha256sum -c "$checksum_name"

database_archive=${checksum_name%.sha256}.pgcustom
files_archive=${checksum_name%.sha256}.files.tar.gz
docker compose exec -T db pg_restore --list < "$database_archive" >/dev/null
tar -tzf "$files_archive" >/dev/null
echo "Backup archives are readable and checksums match."
