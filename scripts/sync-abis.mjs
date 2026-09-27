import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pin = JSON.parse(await readFile('contracts/source.json', 'utf8'));
const source = process.env.SMART_CONTRACT_DIR ?? '.cache/smart-contract';

if (!process.env.SMART_CONTRACT_DIR) {
  await mkdir('.cache', { recursive: true });
  try {
    execFileSync('git', ['clone', '--recurse-submodules', pin.repo, source], { stdio: 'inherit' });
  } catch {}
  execFileSync('git', ['-C', source, 'checkout', '--detach', pin.commit], { stdio: 'inherit' });
}
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== pin.commit) throw new Error(`smart-contract must be pinned at ${pin.commit}`);

await rm('contracts/abi', { recursive: true, force: true });
await mkdir('contracts/abi', { recursive: true });
for (const name of ['FarmentaMarket', 'MarketLens']) {
  await cp(resolve(source, `out/${name}.sol/${name}.json`), `contracts/abi/${name}.json`);
}
