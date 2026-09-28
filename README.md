# Farmenta backend

NestJS API running directly on Bun for the Farmenta frontend and owner tooling. It is a
server-side service: paid RPC credentials stay in `.env`; it intentionally exposes no generic
JSON-RPC forwarding route.

The architecture specification in [`farmenta-defi/docs`](https://github.com/farmenta-defi/docs)
(`ARCHITECTURE.md` §13) is the source of truth.

## Local setup

Requires Bun and PostgreSQL. Create a database named `farmenta`, then provision the backend
role as a PostgreSQL superuser:

```sh
psql -U postgres -d farmenta -f scripts/create-db-role.sql
psql -U postgres -c '\password farmenta_backend'
```

Start the indexer once before this step so Ponder has created schema `ponder`; the provisioning
script stops on error rather than silently omitting the backend's read grant.

Install dependencies and create the local environment file. `.env` contains secrets and must
remain mode 600.

```sh
bun install
cp .env.example .env
chmod 600 .env
# Fill DATABASE_URL, RPC_URL, INDEXER_STATUS_URL, INDEXER_GRAPHQL_URL, CORS_ORIGINS,
# and FARMENTA_DEPLOYMENT after contracts are deployed.
bun run db:migrate
bun run src/main.ts
```

`DATABASE_URL` must name database `farmenta`; startup and migrations reject another database.
`RPC_URL` is server-only. Do not put it in frontend environment variables or logs.

## Health endpoint

`GET /health` reports `database`, `rpc`, and `indexer` independently. The indexer result uses
Ponder's `/status` timestamp to compute lag in seconds. A failed dependency changes the overall
status to `error` without returning URLs, credentials, or provider error text.

Only origins in `CORS_ORIGINS` are accepted. The API applies a 60-requests-per-minute limit per
IP. Set `TRUST_PROXY=1` only behind the VPS's single trusted reverse proxy so the limiter uses
the client IP rather than the proxy address. No route accepts arbitrary `eth_call` or other
JSON-RPC payloads.

## Database ownership

Application tables live in schema `backend`: `hf_snapshot`, `market_snapshot`, and
`service_heartbeat`. Ponder owns schema `ponder`. `farmenta_backend` has read-only access to
the latter, and the provision script revokes all write privileges from it. Verify the boundary:

```sh
psql "$DATABASE_URL" -c 'insert into ponder.loan (market, token_id) values (''0x0'', 0)'
# ERROR: permission denied for table loan
```

The provision script also revokes this role's `CONNECT` privilege on the unrelated `lpmon`
database on the shared Postgres server.

## Liquidation snapshots

The backend refreshes health-factor snapshots every 30 seconds. Each cycle reads the in-custody
loans from the indexer and pins `liquidationHealthFactor`, `debtOf`, oracle pricing, and pool terms
to one chain block. USDG debt and its USD value (1e18 units) are both stored. Multicall uses
`allowFailure`; a failed position is retained with `status: error` and does not discard other
positions. `/liquidations` returns the latest debt-bearing positions ordered by health factor and
sets `stale: true` when the snapshot is older than 90 seconds. Snapshot completion updates the
`backend-hf-snapshot` heartbeat.

Multicall is split into batches of at most 100 view calls (up to 50 positions before pool-term
reads), all pinned to the same block. This is a conservative initial RPC budget, not a verified
provider gas ceiling. The latest recorded contract test measurement for `MarketLens.healthFactor`
is 118,191 gas; FAR-38's runtime call is `liquidationHealthFactor`, so its deployed gas usage and
the provider's `eth_call` ceiling still need measurement against the configured RPC and deployment.
The implementation keeps batches bounded and reports cycle duration in the heartbeat details so
the 150-loan/30-second target can be checked in the deployed environment.

## Contract artifacts and deployments

`contracts/source.json` pins the `smart-contract` revision shared with the indexer. Regenerate
the server-side ABI files with `bun run abi:sync`; set `SMART_CONTRACT_DIR=../smart-contract`
to reuse a clean checkout at that exact revision. Contract addresses are deployment configuration,
not literals in application code. Copy `deployments/example.json` only after a deployment exists.

## VPS deploy with pm2

On the VPS, run Bun under the same service account that owns `.env`:

```sh
bun install --frozen-lockfile
bun run db:migrate
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs farmenta-backend
curl -s http://127.0.0.1:3000/health
```

The PM2 file runs `bun run src/main.ts` directly; there is no production build step. Run one
instance until shared scheduling is introduced by a later ticket.

## Checks

```sh
bun run lint
bun run test
bun run test:e2e
bun run build
```
