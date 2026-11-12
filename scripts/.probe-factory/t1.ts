import { onNode, locally, show, runData, create, assetParams, stableParams, tokenAt, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const salt = `0x${'a1'.repeat(32)}` as const;
const T = tokenAt(0, PROBE, salt);
const cs: C[] = [
  { to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, kind: 0 },
  { to: T, data: '0x', gas: 0n, kind: 2 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('baseline asset create', await onNode(txs, block), await locally(txs, block));
