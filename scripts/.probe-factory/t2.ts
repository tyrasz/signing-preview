import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, tokenAt, factoryAbi, PROBE, FACTORY, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
// A: stablecoin exists, then created again with an invalid / empty currency (same salt)
{
  const salt = s('b1');
  const cs: C[] = [
    { to: FACTORY, data: create(1, salt, stableParams()), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, 'usd')), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, '')), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, 'EUR', 2)), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams()), gas: 500_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 5_000_000n }];
  show('A: existing stablecoin, invalid currency', await onNode(txs, block), await locally(txs, block));
}
// B: token address warmed before the creation
{
  const salt = s('b2');
  const T = tokenAt(0, PROBE, salt);
  const cs: C[] = [
    { to: T, data: '0x', gas: 0n, kind: 2 },
    { to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
  show('B: token warm before creation', await onNode(txs, block), await locally(txs, block));
}
// C: views
{
  const salt = s('b3');
  const T = tokenAt(0, PROBE, salt);
  const existing = '0xb2000000000000000000008799da4a879f289454';
  const cs: C[] = [
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [T as `0x${string}`] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [T as `0x${string}`] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [PROBE as `0x${string}`] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'getB20Address', args: [0, PROBE as `0x${string}`, salt] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20', args: [T as `0x${string}`] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'getB20Address', args: [2, PROBE as `0x${string}`, salt] }), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: create(2, salt, assetParams()), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, salt, '0x1234'), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: '0x62975e6a', gas: 500_000n, kind: 0 },
    { to: FACTORY, data: '0x12345678', gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, kind: 1 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 5_000_000n }];
  show('C: views, bad variant, bad params, static', await onNode(txs, block), await locally(txs, block));
}
