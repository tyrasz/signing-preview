import { encodeFunctionData, parseAbi } from 'viem';
import { onNode, locally, show, runData, create, assetParams, stableParams, tokenAt, factoryAbi, PROBE, FACTORY, SENDER, blockNumber, URL_, type C } from './lib.ts';
const block = await blockNumber() - 2n;
const s = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const rpc = async (method: string, params: unknown[]) => (await (await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as { result: any }).result;
const logs = await rpc('eth_getLogs', [{ address: FACTORY, fromBlock: `0x${(block - 40000n).toString(16)}`, toBlock: `0x${block.toString(16)}` }]);
console.log('factory logs', logs?.length, logs?.[0]?.topics, logs?.[0]?.transactionHash);
const real = logs?.length ? `0x${logs[0].topics[1].slice(26)}` : '0xb2000000000000000000008799da4a879f289454';
console.log('real token', real, await rpc('eth_getCode', [real, 'latest']), await rpc('eth_getTransactionCount', [real, 'latest']));
const isInit = (a: string) => encodeFunctionData({ abi: factoryAbi, functionName: 'isB20Initialized', args: [a as `0x${string}`] });
// 7/15: isB20Initialized of a real token, a variant-2 address; two creations in one tx
{
  const cs: C[] = [
    { to: FACTORY, data: isInit(real), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: isInit('0xb200000000000000000002123456789abcdef012'), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: isInit('0xb2000000000000000000ff123456789abcdef012'), gas: 100_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('f1'), assetParams()), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(0, s('f2'), assetParams()), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, s('f3'), stableParams()), gas: 500_000n, kind: 0 },
    { to: FACTORY, data: create(1, s('f4'), stableParams()), gas: 500_000n, kind: 0 },
  ];
  const txs = [{ to: PROBE, data: runData(cs), gas: 3_000_000n }];
  show('isB20Initialized variants; two creations in one tx', await onNode(txs, block), await locally(txs, block));
}
// 13: delegatecall / callcode to the factory
{
  const DEL = '0x00000000000000000000000000000000000de1e9', CC = '0x00000000000000000000000000000000000de1ea';
  const delegator = `0x365f5f375f5f365f73${FACTORY.slice(2)}5af43d5f5f3e6029573d5ffd5b3d5ff3`;
  // callcode: CALLDATACOPY; push retSize 0, retOff 0, argsSize, argsOff 0, value 0, addr, gas; CALLCODE (0xf2)
  const callcoder = `0x365f5f37 5f5f 36 5f 5f 73${FACTORY.slice(2)} 5a f2 3d5f5f3e 602b57 3d5ffd 5b 3d5ff3`.replace(/ /g, '');
  const extra = { [DEL]: { code: delegator }, [CC]: { code: callcoder } };
  const txs = [
    { to: DEL, data: create(0, s('f5'), assetParams()), gas: 500_000n },
    { to: CC, data: create(0, s('f6'), assetParams()), gas: 500_000n },
    { to: DEL, data: isInit(real), gas: 500_000n },
  ];
  const n = await onNode(txs, block, extra);
  const l = await locally(txs, block, false, extra);
  show('delegatecall / callcode to factory', n, l);
  console.log(JSON.stringify(n.map(x => x.error)));
}
