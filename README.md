# Mashqban

Mashqban is a Persian-language Bale Messenger bot for collecting daily homework, managing classes, providing feedback, and reporting student participation. The repository now includes a Bun/TypeScript scaffold, database schema and migrations, and an initial command-based bot runtime. The MVP is still incomplete and has not been verified against a live Bale test bot.

## Development

Use Bun 1.4.x. Run `bun install` and `bun run typecheck`. Copy `.env.example` to `.env` and replace all placeholders. `bun run check:config` validates required configuration without printing secrets. `docker compose up -d db` starts the local PostgreSQL 17 database, then `bun run db:migrate` applies committed migrations. `bun run start` starts the initial polling runtime. The full MVP workflows, live Bale contract, retention cleanup and deployment are not yet complete.

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
