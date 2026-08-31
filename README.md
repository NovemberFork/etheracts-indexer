# etheracts-indexer

Indexes Etheracts events from Starknet into Postgres. Append-only event log with SQL views on top; self-migrating on boot; reorg-safe.

## Run

```bash
cp .env.example .env   # fill in RPC_URL and DATABASE_URL
docker compose up -d   # without docker: pnpm install && pnpm dev
```

`docker compose logs -f` to watch it sync, `docker compose down` to stop.

## Inspect events without a DB

## Notes

- Live indexing starts at the upgrade block (14,121,414). Earlier history (deploy block 3,588,187 -> upgrade) loads separately as seed data — WIP.
- Schema lives in `sql/`, applied automatically on startup.

