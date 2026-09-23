import { TelegramAlertRepository } from './alert.repository.js';
import { readKeeperConfig } from './keeper.config.js';
import { HttpIndexerRepository } from './indexer.repository.js';
import { KeeperService } from './keeper.service.js';
import { ViemRecorderRepository } from './recorder.repository.js';
import { PostgresKeeperRunRepository } from './run.repository.js';

const config = readKeeperConfig();
const runs = new PostgresKeeperRunRepository(config.databaseUrl);
const service = new KeeperService(
  new HttpIndexerRepository(config.indexerUrl, config.maxIndexerLagSeconds),
  new ViemRecorderRepository(config.rpcUrl, config.privateKey, config.twapRecorder, config.multicall3),
  runs,
  new TelegramAlertRepository(config.telegramBotToken, config.telegramChatId),
);

try {
  const result = await service.run({ dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
} finally {
  await runs.close();
}
