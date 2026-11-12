import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, tokenAt, factoryAbi, PROBE, FACTORY, SENDER, blockNumber, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const erc20 = parseAbi(['function name() view returns (string)', 'function mint(address,uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function totalSupply() view returns (uint256)', 'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']);
const mint = encodeFunctionData({ abi: erc20, functionName: 'mint', args: [PROBE, 1000n] });
// P: gas short of a creation, at points through it
{
  const cs: C[] = [5_000n, 30_000n, 60_000n, 100_000n, 125_000n, 129_000n].map((g, i) => ({ to: FACTORY, data: create(0, s(`d${i}`), assetParams(), [mint]), gas: g, kind: 0 }));
  const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
  show('P: short of gas', await onNode(txs, block), await locally(txs, block));
}
// I: init calls DOMAIN_SEPARATOR / permit (bad signature) inside the creation; O: init call mint short of an argument
{
  const ds = encodeFunctionData({ abi: erc20, functionName: 'DOMAIN_SEPARATOR' });
  const permit = encodeFunctionData({ abi: erc20, functionName: 'permit', args: [PROBE, SENDER, 1n, 2n ** 64n, 27, s('11'), s('22')] });
  const short = mint.slice(0, 2 + 2 * (4 + 32 + 10)) as `0x${string}`;
  const cs: C[] = [
    { to: FACTORY, data: create(0, s('e1'), assetParams(), []), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('e2'), assetParams(), [ds]), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('e3'), assetParams(), [permit]), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('e4'), assetParams(), [short]), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('e5'), assetParams(), ['0xdeadbeef']), gas: 500_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 5_000_000n }];
  show('I/O: hashing and undecodable init calls', await onNode(txs, block), await locally(txs, block));
}
// J: read the new token in the same transaction
{
  const salt = s('e6'); const T = tokenAt(0, PROBE, salt);
  const cs: C[] = [
    { to: FACTORY, data: create(0, salt, assetParams('A long token name that passes 32 bytes'), [mint]), gas: 500_000n, kind: 0 },
    { to: T, data: encodeFunctionData({ abi: erc20, functionName: 'name' }), gas: 100_000n, kind: 0 },
    { to: T, data: encodeFunctionData({ abi: erc20, functionName: 'totalSupply' }), gas: 100_000n, kind: 0 },
    { to: T, data: encodeFunctionData({ abi: erc20, functionName: 'mint', args: [PROBE, 1n] }), gas: 100_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
  show('J: read back in the same transaction', await onNode(txs, block), await locally(txs, block));
}
