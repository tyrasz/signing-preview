import { both, timed, timerOver, TIMER, USER } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', A = '0x8453000000000000000000000000000000000001', F = '0xb20f000000000000000000000000000000000000', T = '0xb200000000000000000000397293cb8cda9a10c5';
const isB20 = '0xfa19b927' + T.slice(2).padStart(64, '0');
await both('factory delegatecall isB20', [{ to: TIMER, data: timed(F, isB20, 2) }], timerOver(), { untime: true });
await both('factory callcode isB20', [{ to: TIMER, data: timed(F, isB20, 3) }], timerOver(), { untime: true });
await both('factory value isB20', [{ to: TIMER, data: timed(F, isB20, 0, 1n) }], timerOver(), { untime: true });
await both('factory staticcall isB20', [{ to: TIMER, data: timed(F, isB20, 1) }], timerOver(), { untime: true });
await both('factory value createB20 short', [{ to: TIMER, data: timed(F, '0x62975e6a', 0, 1n) }], timerOver(), { untime: true });
await both('factory value empty', [{ to: TIMER, data: timed(F, '0x', 0, 1n) }], timerOver(), { untime: true });
await both('token delegatecall decimals', [{ to: TIMER, data: timed(T, '0x313ce567', 2) }], timerOver(), { untime: true });
await both('registry callcode', [{ to: TIMER, data: timed(P, '0x330f5637' + '00'.repeat(32), 3) }], timerOver(), { untime: true });
// top-level tx straight to the factory with no data / value
await both('top-level factory no data', [{ to: F, data: '0x' }]);
await both('top-level policy no data', [{ to: P, data: '0x' }]);
await both('top-level activation 1 byte', [{ to: A, data: '0x01' }]);
