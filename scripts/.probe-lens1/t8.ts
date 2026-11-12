import { both, timed, timerOver, TIMER } from './h.ts';
const T = '0xb200000000000000000000397293cb8cda9a10c5', P = '0x8453000000000000000000000000000000000002';
const t0 = Date.now();
await both('loop override on token, symbol() with 100k', [{ to: TIMER, data: timed(T, '0x95d89b41', 0, 0n, 100_000n), gas: 2_000_000n }], timerOver({ [T]: { code: '0x5b5f56' } }), { untime: true });
console.log('ms', Date.now() - t0);
await both('gas-reading override on policy registry', [{ to: TIMER, data: timed(P, '0x', 0, 0n, 100_000n), gas: 2_000_000n }], timerOver({ [P]: { code: '0x5a60005260206000f3' } }), { untime: true });
