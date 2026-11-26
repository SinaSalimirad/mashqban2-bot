# Operations

## Container deployment

Configure `.env` from `.env.example` with strong secrets and a private Bale test bot first. Review SQL under `drizzle/` before `docker compose up -d --build`. The `migrate` service applies pending migrations before the backend starts. The backend polls Bale; Nginx exposes only local `/health` and `/ready` on `HTTP_PORT`. Put a TLS reverse proxy at the deployment edge before granting remote access.

## Backup and recovery

Run `sh scripts/backup.sh /secure/backup/destination` on the Compose host. The script stops the backend briefly, takes a PostgreSQL custom-format dump and an archive of the private file volume, then restarts the backend even if an archive command fails. Treat both archives as sensitive student data. Transfer them to separately protected storage with encryption and an access policy; a copy on the same host does not cover host loss. Keep a paired database and file archive from the same backup run.

To validate recovery, use an isolated deployment with empty volumes. Restore the database archive using `pg_restore -U mashqban -d mashqban --clean --if-exists` inside its database container, and extract the paired file archive into the private file volume before starting the backend. Do not run restore against a live deployment without an approved recovery plan: `--clean` replaces existing tables. Check the restored `/ready` endpoint, a historical homework file, and report data using synthetic records. The project has no verified production restore yet.

## Delivery uncertainty

An outbox item with `unknown` status may already have reached Bale. Inspect `docker compose exec app bun run src/container.ts outbox list`; use `outbox retry MESSAGE_ID` only after checking the recipient chat. Retrying may duplicate a message. The list command displays IDs, kind, status, attempt count, and error code without message contents.

## File retention

The backend checks for expired private files every minute in batches of 50. A file from a school year ending on 31 Shahrivar is eligible after the following 31 Shahrivar has ended. The worker leaves a historical `purged` asset row and checks that no unexpired homework date or open draft still references the file. Monitor backup success and free disk space before collecting real student data.
