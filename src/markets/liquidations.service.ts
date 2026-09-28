import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { type Address } from 'viem';
import { IndexerService } from '../indexer/indexer.service.js';
import { RpcService } from '../rpc/rpc.service.js';
import {
  lensAbi,
  marketAbi,
  oracleAbi,
  policyAbi,
  policyEffectiveLtAbi,
} from './contracts.js';
import { DeploymentService } from './deployment.service.js';
import { HealthFactorRow, MarketRepository } from './market.repository.js';

const INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const MAX_CALLS_PER_BATCH = 100;
const LOANS_QUERY = `query Loans($market: String!) { loans(limit: 1000, where: { market: $market, status: "in_custody" }) { items { tokenId owner poolId } } }`;
const POOLS_QUERY = `query Pools { pools(limit: 1000) { items { id currency0 currency1 } } }`;

type Loan = { tokenId: string; owner: string; poolId: string };
type Pool = { id: string; currency0: string | null; currency1: string | null };
type MulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error?: unknown };
type OracleValues = { price: bigint; decimals: bigint };
type Listing = {
  ltStartBps: bigint;
  ltTargetBps: bigint;
  rampStart: bigint;
  rampDuration: bigint;
  liquidatorBonusBps: bigint;
};

@Injectable()
export class LiquidationsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(LiquidationsService.name);

  constructor(
    private readonly deployments: DeploymentService,
    private readonly rpc: RpcService,
    private readonly indexer: IndexerService,
    private readonly repository: MarketRepository,
  ) {}

  onModuleInit() {
    void this.captureSafely();
    this.timer = setInterval(() => void this.captureSafely(), INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async liquidations() {
    const [rows, heartbeat] = await Promise.all([
      this.repository.latestHealthFactors(),
      this.repository.latestHealthFactorHeartbeat(),
    ]);
    const snapshotAt = rows[0]?.observedAt ?? heartbeat?.observedAt ?? null;
    const stale =
      !snapshotAt ||
      Date.now() - new Date(snapshotAt).getTime() > STALE_AFTER_MS;
    const queue = rows
      .filter(
        (row) => row.status !== 'error' && BigInt(row.debtUsdg ?? '0') > 0n,
      )
      .map((row) => ({
        id: row.tokenId,
        positionId: row.tokenId,
        borrower: row.borrower,
        collateral: row.poolId,
        debtUsd: row.debtUsd,
        debtUsdg: row.debtUsdg,
        healthFactor: row.healthFactor,
        threshold: row.thresholdBps === null ? null : row.thresholdBps / 10_000,
        bonus: row.bonusBps === null ? null : row.bonusBps / 10_000,
        status: row.status,
        snapshotAt: row.observedAt,
        rampActive: row.rampActive,
        market: row.market,
        blockNumber: row.blockNumber,
      }));
    return {
      items: queue,
      snapshotAt,
      blockNumber:
        rows[0]?.blockNumber ?? heartbeat?.details.blockNumber ?? null,
      stale,
    };
  }

  private captureSafely() {
    if (this.running) return this.running;
    this.running = this.capture()
      .catch((error: unknown) => {
        this.logger.error(
          `Health factor snapshot failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async capture() {
    const startedAt = Date.now();
    const blockNumber = await this.rpc.getBlockNumber();
    const block = await this.rpc.clientForRead
      .getBlock({ blockNumber })
      .catch(() => {
        throw new Error('RPC is unavailable');
      });
    const observedAt = new Date(Number(block.timestamp) * 1_000);
    const [loansByMarket, poolsData] = await Promise.all([
      Promise.all(
        this.deployments.all().map(async ([, raw]) => {
          const deployment = await this.deployments.resolve(raw);
          const result = await this.indexer.query<{ loans: { items: Loan[] } }>(
            LOANS_QUERY,
            { market: deployment.address.toLowerCase() },
          );
          return { deployment, loans: result.loans.items };
        }),
      ),
      this.indexer.query<{ pools: { items: Pool[] } }>(POOLS_QUERY),
    ]);
    const poolNames = new Map(
      poolsData.pools.items.map((pool) => [
        pool.id.toLowerCase(),
        pool.currency0 && pool.currency1
          ? `${pool.currency0}/${pool.currency1}`
          : pool.id,
      ]),
    );
    const rows: HealthFactorRow[] = [];
    for (const { deployment, loans } of loansByMarket) {
      rows.push(
        ...(await this.captureMarket(
          deployment.address,
          deployment.lens,
          deployment.policy,
          loans,
          poolNames,
          blockNumber,
          observedAt,
        )),
      );
    }
    await this.repository.insertHealthFactors(rows, blockNumber, observedAt);
    await this.repository.heartbeat(observedAt, {
      blockNumber: blockNumber.toString(),
      positions: rows.length,
      errors: rows.filter((row) => row.status === 'error').length,
      durationMs: Date.now() - startedAt,
    });
  }

  private async captureMarket(
    market: Address,
    lens: Address,
    policy: Address,
    loans: Loan[],
    poolNames: Map<string, string>,
    blockNumber: bigint,
    observedAt: Date,
  ): Promise<HealthFactorRow[]> {
    if (loans.length === 0) return [];
    const config = (await this.rpc.multicall(
      [
        { address: market, abi: marketAbi, functionName: 'asset' },
        { address: market, abi: marketAbi, functionName: 'oracle' },
      ],
      blockNumber,
    )) as MulticallResult[];
    if (config[0]?.status !== 'success' || config[1]?.status !== 'success')
      return loans.map((loan) =>
        errorRow(
          market,
          loan,
          poolNames.get(loan.poolId.toLowerCase()) ?? loan.poolId,
        ),
      );
    const asset = config[0].result as Address;
    const oracle = config[1].result as Address;
    const prices = (await this.rpc.multicall(
      [
        {
          address: oracle,
          abi: oracleAbi,
          functionName: 'priceForLiquidation',
          args: [asset],
        },
        {
          address: oracle,
          abi: oracleAbi,
          functionName: 'decimals',
          args: [asset],
        },
      ],
      blockNumber,
    )) as MulticallResult[];
    if (prices[0]?.status !== 'success' || prices[1]?.status !== 'success')
      return loans.map((loan) =>
        errorRow(
          market,
          loan,
          poolNames.get(loan.poolId.toLowerCase()) ?? loan.poolId,
        ),
      );
    const oracleValues: OracleValues = {
      price: prices[0].result as bigint,
      decimals: prices[1].result as bigint,
    };
    const pools = [...new Set(loans.map((loan) => loan.poolId.toLowerCase()))];
    const calls = [
      ...loans.flatMap((loan) => [
        {
          address: lens,
          abi: lensAbi,
          functionName: 'liquidationHealthFactor',
          args: [BigInt(loan.tokenId)],
        },
        {
          address: market,
          abi: marketAbi,
          functionName: 'debtOf',
          args: [BigInt(loan.tokenId)],
        },
      ]),
      ...pools.flatMap((poolId) => [
        {
          address: policy,
          abi: policyAbi,
          functionName: 'listingOf',
          args: [poolId as `0x${string}`],
        },
        {
          address: policy,
          abi: policyEffectiveLtAbi,
          functionName: 'effectiveLt',
          args: [poolId as `0x${string}`],
        },
      ]),
    ];
    const results: MulticallResult[] = [];
    for (let start = 0; start < calls.length; start += MAX_CALLS_PER_BATCH) {
      const batch = (await this.rpc.multicall(
        calls.slice(start, start + MAX_CALLS_PER_BATCH),
        blockNumber,
      )) as MulticallResult[];
      results.push(...batch);
    }
    const policyOffset = loans.length * 2;
    const terms = new Map<
      string,
      { listing: Listing; lt: number; rampActive: boolean }
    >();
    pools.forEach((poolId, index) => {
      const listingResult = results[policyOffset + index * 2];
      const ltResult = results[policyOffset + index * 2 + 1];
      if (listingResult?.status !== 'success' || ltResult?.status !== 'success')
        return;
      const listing = listingResult.result as Listing;
      const now = BigInt(Math.floor(observedAt.getTime() / 1_000));
      const start = listing.rampStart;
      const end = start + listing.rampDuration;
      terms.set(poolId, {
        listing,
        lt: Number(ltResult.result),
        rampActive: listing.rampDuration > 0n && now >= start && now < end,
      });
    });
    return loans.map((loan, index) => {
      const hf = results[index * 2];
      const debt = results[index * 2 + 1];
      const term = terms.get(loan.poolId.toLowerCase());
      if (hf?.status !== 'success' || debt?.status !== 'success' || !term) {
        return errorRow(
          market,
          loan,
          poolNames.get(loan.poolId.toLowerCase()) ?? loan.poolId,
        );
      }
      const healthFactor = BigInt(hf.result as bigint);
      const debtUsdg = BigInt(debt.result as bigint);
      const debtUsd =
        (debtUsdg * oracleValues.price) / 10n ** oracleValues.decimals;
      const status =
        debtUsdg === 0n
          ? 'healthy'
          : healthFactor < 10n ** 18n
            ? 'liquidatable'
            : healthFactor < 105n * 10n ** 16n
              ? 'at-risk'
              : healthFactor < 12n * 10n ** 17n
                ? 'warning'
                : 'healthy';
      return {
        market,
        tokenId: loan.tokenId,
        healthFactor: healthFactor.toString(),
        debtUsdg: debtUsdg.toString(),
        debtUsd: debtUsd.toString(),
        poolId: poolNames.get(loan.poolId.toLowerCase()) ?? loan.poolId,
        borrower: loan.owner,
        thresholdBps: term.lt,
        bonusBps: Number(term.listing.liquidatorBonusBps),
        rampActive: term.rampActive,
        status,
        error: null,
      };
    });
  }
}

function errorRow(market: string, loan: Loan, poolId: string): HealthFactorRow {
  return {
    market,
    tokenId: loan.tokenId,
    healthFactor: null,
    debtUsdg: null,
    debtUsd: null,
    poolId,
    borrower: loan.owner,
    thresholdBps: null,
    bonusBps: null,
    rampActive: false,
    status: 'error',
    error: 'Position view reverted',
  };
}
