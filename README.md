# ecto-server

Self-hostable Ecto community server.

## Setup

```bash
cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

## Docker

```bash
docker compose up
# or with SQLite:
docker compose -f docker-compose.sqlite.yml up
```
