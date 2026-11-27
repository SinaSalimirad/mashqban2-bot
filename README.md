# Mashqban

Mashqban is a Persian-language Bale Messenger bot for collecting daily homework, managing classes, providing feedback, and reporting student participation. It runs as a Bun backend with PostgreSQL and private server file storage. The backend connects directly to the Bale API over outbound HTTPS using Long Polling; there is no public web panel or webhook.

## Development

Use Bun 1.4.x. Run `bun install` and `bun run typecheck`. Copy `.env.example` to `.env` and replace all placeholders. `bun run check:config` validates the host-run configuration without printing secrets.

For a container deployment, set `POSTGRES_PASSWORD`, `BALE_BOT_TOKEN`, `TEACHER_BALE_ID`, and a 32-byte-or-longer `INVITE_CODE_SECRET` in `.env`, then follow the production checklist in [operations](docs/OPERATIONS.md). Compose starts PostgreSQL and the hardened Bun backend as a non-root user; the app applies pending migrations before polling Bale. The app exposes `/health` and `/ready` directly at `http://127.0.0.1:8080` (or `HTTP_PORT`). The backend builds the internal PostgreSQL URL from `POSTGRES_PASSWORD`, so reserved URL characters in the password are encoded correctly. The published health and PostgreSQL ports bind only to localhost. Named volumes hold the database and private files; back up both together.

Private homework and voice-feedback files are purged after one year following the relevant 31 Shahrivar school-year end. The scheduled cleanup retains database history with a `purged` file status. Each file is limited to 20 MB and each homework to 20 files. Set up and verify backups before entering real student data. No live Bale bot or production backup/restore has been verified, and this release must be checked with a test bot before real use.

See [operations](docs/OPERATIONS.md) for a paired database/file backup command and recovery guidance.

For local Bun without containers, start PostgreSQL separately, apply `bun run db:migrate`, and use a `DATABASE_URL` with `localhost` rather than the Compose hostname `db`. Do not point the local migration command at a production database without reviewing the SQL in `drizzle/` first.

## Tests

Run `bun run test:unit` for tests that do not need external services. Integration tests require a dedicated, disposable PostgreSQL database because the suite migrates it and truncates all application tables between cases. Set `TEST_DATABASE_URL` to that database and run `bun run test:integration`; run `bun run test:all` for both groups. Never point `TEST_DATABASE_URL` at development or production data.

The integration runner executes database test files sequentially so their isolation cleanup cannot race across files. The suite covers invitation races and rebinding, scoped callbacks and permissions, homework time boundaries and version conflicts, reporting and scheduler recovery, feedback association, durable inbox/outbox behavior, retention, and guided bot flows. Live Bale contract behavior still requires a private test bot.

## Bot commands

- `/start` shows a private, role-specific button menu. `/menu` returns to it; `/cancel` asks for confirmation before abandoning an active workflow. Text commands remain available when buttons are unavailable.
- Teacher setup: choose Classes, Students, or Assistants, then follow the step-by-step create, search, invitation, membership, account-change, and deactivation menus. The direct commands `/class name`, `/student first|last|class-id,class-id`, `/assistant name`, `/invite student|assistant id`, `/rebind student|assistant id`, `/revokeinvite student|assistant id`, `/join student-id class-id`, and `/leave student-id class-id` also work. Rename commands are `/renameclass id name`, `/renamestudent id|first|last`, and `/renameassistant id name`.
- Student submission: `/submit` → choose a class → send a title → send one or more files → use the Review/Finalize buttons. `/title title`, `/finalize`, `/edit homework-id`, `/remove file-position`, `/cancel`, `/today`, `/history`, and `/files homework-id` are text alternatives. Deletion requires `/delete homework-id current-version-id` and a confirmation within the daily window.
- Staff homework and feedback: `/homeworks ۱۴۰۵/۰۹/۰۵ class-id [page] [active|deleted|all]`, `/versions homework-id [page]`, `/files homework-id version-id`, `/feedback homework-id version-id message`, or `/voicefeedback homework-id version-id` followed by voice. Confirm with `/confirmfeedback`; cancel with `/cancel`. `/feedbacks [homework-id|all] [page]` lists history and `/feedbackfile feedback-id` retrieves voice. Students can use `/feedbacks [page]` and `/feedbackfile feedback-id` for their own feedback.
- Reports: `/report [date] [page]`, `/week [date] [page]`, `/month [date] [page]`. Omit the date for today/current period. Dates accept Solar Hijri `YYYY/MM/DD`; daily reports before 22:00 Tehran are marked provisional. Final daily reports and notifications are recovered after restarts.

## Delivery operations

When a Bale network call has an unknown outcome, the outbox leaves the message in `unknown` rather than automatically resending it. Run `docker compose exec app bun run src/container.ts outbox list` to see failed/unknown message IDs without student content. After checking Bale chat history, run `docker compose exec app bun run src/container.ts outbox retry MESSAGE_ID` to queue one message again. Retrying an `unknown` item may duplicate a message that Bale accepted. For host-run development, use `bun run ops:outbox list` and `bun run ops:outbox retry MESSAGE_ID`.

## Documentation

- [Product Requirements](docs/PRD.md)
- [Bot UX](docs/BOT_UX.md)
- [Database Design](docs/DATABASE.md)
- [Architecture & Implementation Plan](docs/ARCHITECTURE.md)
- [Bale API contract review](docs/BALE_API_SPIKE.md)

The repository's collaboration and engineering rules are in [AGENTS.md](AGENTS.md). `CLAUDE.md` imports those rules so there is one source of truth.

The skill sources are kept in `skills/`:

- `double-diamond` for problem discovery and solution design before implementation
- `engineering-mentor` for in-depth explanation, code review, and engineering mentoring
