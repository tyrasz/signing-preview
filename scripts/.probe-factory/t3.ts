import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, tokenAt, factoryAbi, PROBE, FACTORY, SENDER, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const erc20 = parseAbi(['function name() view returns (string)', 'function mint(address,uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function totalSupply() view returns (uint256)']);
// G: invalid currency, little gas
{
  const salt = s('c1');
  const cs: C[] = [
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, 'usd')), gas: 20_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, 'usd')), gas: 36_000n, kind: 0 },
    { to: FACTORY, data: create(1, salt, stableParams('X', 'Y', undefined, 'usd')), gas: 40_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
  show('G: invalid currency, little gas', await onNode(txs, block), await locally(txs, block));
}
// H: created then the caller reverts; next tx checks the token. Also an init call that reverts (supply cap) and then check.
{
  const salt = s('c2'), salt2 = s('c3');
  const T = tokenAt(0, PROBE, salt), T2 = tokenAt(0, PROBE, salt2);
  const big = encodeFunctionData({ abi: erc20, functionName: 'mint', args: [PROBE, 2n ** 255n] });
  const txs = [
    { to: PROBE, data: runData([{ to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, kind: 0 }], true), gas: 3_000_000n },
    { to: PROBE, data: runData([{ to: T, data: '0x', gas: 0n, kind: 2 }, { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [T as `0x${string}`] }), gas: 100_000n, kind: 0 }, { to: FACTORY, data: create(0, salt2, assetParams(), [big]), gas: 500_000n, kind: 0 }, { to: T2, data: '0x', gas: 0n, kind: 2 }, { to: T2, data: encodeFunctionData({ abi: erc20, functionName: 'name' }), gas: 100_000n, kind: 0 }]), gas: 3_000_000n },
    { to: PROBE, data: runData([{ to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, kind: 0 }]), gas: 3_000_000n },
  ];
  show('H: caller reverts; init call reverts', await onNode(txs, block), await locally(txs, block));
}
// K: two creations as two transactions from an EOA; L: with value
{
  const txs = [
    { to: FACTORY, data: create(0, s('c4'), assetParams()), gas: 500_000n },
    { to: FACTORY, data: create(1, s('c5'), stableParams()), gas: 500_000n },
    { to: FACTORY, data: create(0, s('c6'), assetParams()), gas: 500_000n, value: 1n },
    { to: FACTORY, data: create(0, s('c4'), assetParams()), gas: 500_000n },
  ];
  show('K/L: EOA creations', await onNode(txs, block), await locally(txs, block));
}
// N: access list with the token
{
  const salt = s('c7');
  const T = tokenAt(0, SENDER, salt);
  const txs = [{ to: FACTORY, data: create(0, salt, assetParams()), gas: 500_000n, accessList: [{ address: T, storageKeys: [] }] }];
  show('N: access list names the token', await onNode(txs, block), await locally(txs, block));
}
