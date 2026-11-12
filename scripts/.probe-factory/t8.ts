import { onNode, locally, show, runData, create, assetParams, stableParams, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const A = '0x3333333333333333333333333333333333333333';
const cs: C[] = [
  { to: FACTORY, data: create(0, s('71'), assetParams('', '')), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('72'), assetParams('x'.repeat(32), 'y'.repeat(40), A, 6)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(1, s('73'), stableParams('', '', A, 'A'.repeat(40))), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(1, s('74'), stableParams('n', 's', undefined, 'AB')), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('75'), assetParams('n', 's', undefined, 19)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('76'), assetParams('n', 's', undefined, 5)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('77'), assetParams('n', 's', undefined, 18, 2)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(1, s('78'), assetParams('n', 's', undefined, 18)), gas: 500_000n, kind: 0 },
  { to: FACTORY, data: create(0, s('79'), stableParams()), gas: 500_000n, kind: 0 },
];
const txs = [{ to: PROBE, data: runData(cs), gas: 5_000_000n }];
show('edge params', await onNode(txs, block), await locally(txs, block));
