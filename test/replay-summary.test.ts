// scripts/replay-summary.ts: the table across a replay run's reports, and the lists under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('The replay summary: a row per chain and EntryPoint version, then what differed, was warned and fell back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-summary-'));
  const write = (name: string, rows: unknown[]) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'report.json'), JSON.stringify(rows)); };
  write('replay-1-v0.7', [
    { hash: '0xa1', kind: 'hash', outcome: true, whole: true, standIn: 'validated', gas: { percent: 0.01 }, tokens: 'exact' },
    { hash: '0xa2', kind: 'hash', outcome: true, whole: true, standIn: 'validated', gas: { percent: 0.3 }, tokens: 'fee' },
    { hash: '0xa3', kind: 'hash', outcome: false, whole: true, standIn: 'validated', differs: ['outcome'] },
    { hash: '0xa4', kind: 'hash', outcome: false, whole: true, standIn: 'validated', warned: 'outcome' },
    // In a bundle of several: its gas isn't judged, so not in the gas columns.
    { hash: '0xa5', kind: 'hash', outcome: true, whole: true, standIn: 'validated', gas: { percent: 6.6 }, tokens: 'fee', bundle: { size: 2, index: 1 } },
    { hash: '0xa6', kind: 'hash', outcome: true, whole: false, callsOnlyBecause: "The account's validation reverts on a stand-in" },
  ]);
  writeFileSync(join(dir, 'replay-1-v0.7', 'report.skipped.json'), JSON.stringify({ 'its state is no longer served by the node': 2 }));
  write('replay-42161-v0.6', [{ hash: '0xb1', kind: 'SafeOp', outcome: true, whole: true, standIn: 'validated', gas: { percent: 0.02 }, tokens: 'exact' }]);
  mkdirSync(join(dir, 'unrelated'));
  const out = execFileSync(process.execPath, [new URL('../scripts/replay-summary.ts', import.meta.url).pathname, dir], { encoding: 'utf8' });
  assert.match(out, /^## UserOperation replays: 7 operations, 1 differing from their receipts/);
  assert.match(out, /\| Ethereum \| v0\.7 \| 6 \| 4\/6 \| 5\/6 \| 5\/5 \| 2\/2 \| 1\/2 \| 3\/3 \| 1 \| 2 \|/);
  assert.match(out, /\| Arbitrum One \| v0\.6 \| 1 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \| 1\/1 \|  \|  \|/);
  assert.match(out, /Not replayed[\s\S]*- 2: its state is no longer served by the node/);
  assert.match(out, /Previews that differed[\s\S]*`0xa3`: outcome differs/);
  assert.match(out, /warned they might[\s\S]*`0xa4`/);
  assert.match(out, /simulated alone[\s\S]*`0xa6`/);
  assert.doesNotMatch(out, /`0xa5`/);
});
