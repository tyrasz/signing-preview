import { onNode, locally, show, runData, create, assetParams, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const HEVM = '0x7109709ecfa91a80626ff3989d68f67f5b1dd12d';
const cs: C[] = [
  { to: FACTORY, data: create(0, s('41'), assetParams()), gas: 500_000n, kind: 0 },
  { to: HEVM, data: '0x', gas: 0n, kind: 2 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
show('HEVM warm after creation', await onNode(txs, block), await locally(txs, block));
