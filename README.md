# Farmenta Backend

The Farmenta backend is a NestJS API that runs directly on Bun. It serves market and pool data, wallet portfolios, and activity feeds to the Farmenta frontend and owner tools. It reads current contract state through a server-side RPC provider and historical data from the Ponder indexer. PostgreSQL stores backend-owned market snapshots.

The backend does not expose a generic JSON-RPC proxy. Keep paid RPC credentials in the server environment and out of frontend configuration and logs.

For protocol concepts, contract behavior, network information, and the indexer data model, see the [public Farmenta documentation](https://github.com/farmenta-defi/tech-docs).

## API

All endpoints are served from the configured `PORT` (default `3000`). Indexer-backed endpoints return `503` when the indexer is unavailable or its latest block is older than `INDEXER_MAX_LAG_SECONDS` (default `60`).

| Endpoint | Description |
|---|---|
| `GET /health` | Reports database, RPC, and indexer status independently. |
| `GET /markets?range=1w` | Lists configured markets with a current snapshot and historical series. Supported ranges: `1w`, `1m`, `3m`, `1y`. |
| `GET /markets/:tier/pools` | Lists currently listed pools for a configured market tier. |
| `GET /pools/:poolId?range=1w` | Returns details and history for a listed pool. |
| `GET /portfolio/:address` | Returns indexed wallet positions and loans, with on-chain valuations, plus vault shares. |
| `GET /activity/:address?limit=25&cursor=...` | Returns a wallet's loan, liquidation, and vault activity. `limit` is 1–100; the response includes `nextCursor` and `hasMore`. |
| `GET /pools/:poolId/activity?limit=25&cursor=...&kind=...` | Returns listed-pool deposits, withdrawals, borrows, repayments, and liquidations. `kind` may be `deposit`, `withdraw`, `borrow`, `repay`, or `liquidation`. |

Activity feeds are ordered newest first by block and log index. Their cursors use the format `blockNumber:logIndex`. Amounts are returned as decimal strings in their smallest unit. Unavailable or stale indexer data returns `503`; an unlisted pool returns `404`.

`/markets` and the listed-pool endpoints read market state from the chain and snapshot history from the backend database. The backend captures market snapshots every five minutes. Requests for indexed pools, portfolios, and activity depend on a fresh indexer.

## Requirements

- [Bun](https://bun.sh/)
- PostgreSQL
- A running Ponder indexer with its status and GraphQL endpoints
- A server-side RPC endpoint for Robinhood Chain
- A deployment manifest for deployed Farmenta contracts

## Local setup

Create the `farmenta` database and initialize the indexer once so that its `ponder` schema exists. Then provision the backend database role as a PostgreSQL superuser:

```sh
psql -U postgres -d farmenta -f scripts/create-db-role.sql
psql -U postgres -c '\password farmenta_backend'
```

Install dependencies and prepare the environment file. `.env` contains credentials; restrict access to it on shared machines.

```sh
bun install
cp .env.example .env
chmod 600 .env
```

Set the required values in `.env`, then run the migrations and start the API:

```sh
bun run db:migrate
bun run src/main.ts
```

`DATABASE_URL` must point to the `farmenta` database. `RPC_URL` is server-only. Configure `CORS_ORIGINS` as a comma-separated list of allowed frontend origins.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string for the `farmenta` database. Required. |
| `RPC_URL` | Server-side RPC endpoint. Required. |
| `INDEXER_STATUS_URL` | Ponder `/status` endpoint. Required. |
| `INDEXER_GRAPHQL_URL` | Ponder GraphQL endpoint. Required. |
| `INDEXER_MAX_LAG_SECONDS` | Maximum accepted indexer lag; defaults to `60`. |
| `FARMENTA_DEPLOYMENT` | Deployment manifest name in `deployments/`, without `.json`. Required for market and portfolio data. |
| `CORS_ORIGINS` | Comma-separated list of allowed browser origins. |
| `TRUST_PROXY` | Set to `1` only when behind one trusted reverse proxy. Defaults to `0`. |
| `PORT` | HTTP port. Defaults to `3000`. |

The API applies a rate limit of 60 requests per minute per IP. Enable `TRUST_PROXY=1` only when the service is behind its single trusted reverse proxy, so rate limiting uses the client IP.

## Database access

Application tables are stored in the `backend` schema. Ponder owns the `ponder` schema; `farmenta_backend` receives read-only access to it. Run the provisioning script after the indexer has created its schema. Apply backend schema changes with:

```sh
bun run db:migrate
```

## Contract artifacts and deployment manifests

`contracts/source.json` pins the smart-contract revision used to generate the server-side ABIs. To regenerate them, check out that revision and run:

```sh
SMART_CONTRACT_DIR=../smart-contract bun run abi:sync
```

Contract addresses are supplied through a deployment manifest in `deployments/`. Set `FARMENTA_DEPLOYMENT` to its filename without the `.json` extension. `deployments/example.json` is a template; replace its placeholder values with deployed contract addresses before using it.

## VPS deployment with PM2

Run Bun under the service account that owns the environment file:

```sh
bun install --frozen-lockfile
bun run db:migrate
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs farmenta-backend
curl -s http://127.0.0.1:3000/health
```

PM2 runs `bun run src/main.ts` directly. The provided process configuration starts one instance.

## Development checks

```sh
bun run lint
bun run test
bun run test:e2e
bun run build
```
