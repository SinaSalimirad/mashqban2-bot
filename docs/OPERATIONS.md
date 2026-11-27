# Operations

## Container deployment

Use a dedicated Linux host with Docker Compose v2, enough disk for PostgreSQL, private files, and off-host backups. Configure `.env` from `.env.example` with strong unique secrets and restrict it to the deployment account (`chmod 600 .env`). Generate `INVITE_CODE_SECRET` with `openssl rand -hex 32`; never reuse the bot token or database password for it. Use a private Bale test bot for the first end-to-end deployment.

Before the first start, review SQL under `drizzle/`, confirm the two published ports bind to `127.0.0.1`, and validate the rendered configuration without printing it:

```sh
docker compose config --quiet
docker compose build --pull
docker compose run --rm --no-deps app bun run src/container.ts check
docker compose up -d --remove-orphans
docker compose ps
curl --fail --silent http://127.0.0.1:${HTTP_PORT:-8080}/health
curl --fail --silent http://127.0.0.1:${HTTP_PORT:-8080}/ready
```

The app applies pending migrations before starting the bot; migration errors appear in `docker compose logs app`. This avoids a `podman-compose` wait loop when a one-shot migration service fails. The runtime image contains production dependencies only; migrations use the runtime Drizzle migrator rather than development tooling. The backend connects directly to `tapi.bale.ai` over outbound HTTPS and polls for updates, so it needs no public webhook or Nginx. The app serves only `/health` and `/ready` on the localhost-bound `HTTP_PORT`; keep PostgreSQL local as configured. If remote health access is needed, use a private monitoring network or a separately managed authenticated TLS endpoint.

`/health` confirms that the process can answer HTTP. `/ready` additionally checks the database and the bot-loop heartbeat; it becomes unavailable when shutdown starts or the loop has not completed useful work for 90 seconds. Alert on repeated container restarts, `/ready` failures longer than two minutes, PostgreSQL disk usage, and backup age. Container logs rotate at five 10 MB files per service, so forward logs externally if longer retention is required.

## Release and rollback

Before every production update, run the full CI suite, read new migration SQL, create and verify a backup, and record the currently deployed Git commit and image ID. Then pull the intended commit and run `docker compose up -d --build --remove-orphans`. Confirm `docker compose ps`, `/ready`, recent logs, and one synthetic Bale interaction.

Application rollback is `git checkout` of the previously recorded commit followed by `docker compose up -d --build`, provided its code is compatible with the already-applied schema. Database migrations in this repository are forward-only. If a migration is incompatible, restoring the paired pre-release database and file backup is a destructive recovery operation and must be rehearsed on an isolated host first. Never improvise a production schema rollback.

## Backup and recovery

Run `sh scripts/backup.sh /secure/backup/destination` on the Compose host. The script stops the backend briefly when it is running, takes a PostgreSQL custom-format dump and an archive of the private file volume, writes SHA-256 checksums, and restores the backend to its previous running state. Treat all three files as sensitive student data. Transfer them to separately protected storage with encryption and an access policy; a copy on the same host does not cover host loss. Keep the paired database, file archive, and checksum file from the same backup run.

Verify every backup while its Compose database is available:

```sh
sh scripts/verify-backup.sh /secure/backup/destination/mashqban-TIMESTAMP.sha256
```

Verification checks both hashes and asks `pg_restore` and `tar` to parse the archives without restoring data. Schedule backup and verification with the host scheduler, monitor the exit code and age, and periodically copy a verified set to the isolated recovery environment.

To validate recovery, use an isolated deployment with empty volumes. Restore the database archive using `pg_restore -U mashqban -d mashqban --clean --if-exists` inside its database container, and extract the paired file archive into the private file volume before starting the backend. Do not run restore against a live deployment without an approved recovery plan: `--clean` replaces existing tables. Check the restored `/ready` endpoint, a historical homework file, and report data using synthetic records. The project has no verified production restore yet.

## First production acceptance

Do not enroll real students until all of these have been observed with a test bot and synthetic data:

- Teacher bootstrap, invitation redemption, role-specific menus, and permission denial.
- Homework upload, finalize, edit/delete window boundaries, text feedback, and voice feedback.
- Daily report closure after 22:00 Tehran and restart recovery for inbox/outbox work.
- Backup verification and a full isolated restore of both PostgreSQL and private files.
- Host reboot with automatic container recovery and no duplicate polling instance.
- Private monitoring access, disk alerts, backup alerts, and documented operator access.

## Delivery uncertainty

An outbox item with `unknown` status may already have reached Bale. Inspect `docker compose exec app bun run src/container.ts outbox list`; use `outbox retry MESSAGE_ID` only after checking the recipient chat. Retrying may duplicate a message. The list command displays IDs, kind, status, attempt count, and error code without message contents.

## File retention

The backend checks for expired private files every minute in batches of 50. A file from a school year ending on 31 Shahrivar is eligible after the following 31 Shahrivar has ended. The worker leaves a historical `purged` asset row and checks that no unexpired homework date or open draft still references the file. Monitor backup success and free disk space before collecting real student data.
