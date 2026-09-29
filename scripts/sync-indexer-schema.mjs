import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const pin = JSON.parse(await readFile('indexer.schema.source.json', 'utf8'));
const source = process.env.INDEXER_REPO_DIR ?? '.cache/indexer';

if (!process.env.INDEXER_REPO_DIR && !existsSync(source)) {
  await mkdir('.cache', { recursive: true });
  execFileSync('git', ['clone', pin.repo, source], { stdio: 'inherit' });
}
if (!existsSync(source)) {
  throw new Error(`indexer checkout not found at ${source}`);
}
if (!process.env.INDEXER_REPO_DIR) {
  execFileSync('git', ['-C', source, 'checkout', '--detach', pin.commit], {
    stdio: 'inherit',
  });
}

const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (commit !== pin.commit)
  throw new Error(`indexer must be pinned at ${pin.commit}`);

await copyFile(`${source}/ponder.schema.ts`, 'ponder.schema.ts');
