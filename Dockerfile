FROM oven/bun:1.4.4-slim

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun tsconfig.json drizzle.config.ts ./
COPY --chown=bun:bun drizzle ./drizzle
COPY --chown=bun:bun src ./src

RUN mkdir -p /var/lib/mashqban/files && chown -R bun:bun /var/lib/mashqban

USER bun
ENV NODE_ENV=production FILE_STORAGE_DIR=/var/lib/mashqban/files
EXPOSE 3000
CMD ["bun", "run", "src/container.ts", "app"]
