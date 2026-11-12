import { both, timed, timerOver, TIMER, USER } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', F = '0xb20f000000000000000000000000000000000000', T = '0xb200000000000000000000397293cb8cda9a10c5';
const E = '0xb2000000000000000000001111111111111111ff'; // no token there
const D = '0x00000000000000000000000000000000000de1e8';
const dec = '0x313ce567';
await both('empty token: call decimals', [{ to: TIMER, data: timed(E, dec) }], timerOver(), { untime: true });
await both('empty token: call with value', [{ to: TIMER, data: timed(E, dec, 0, 1n) }], timerOver(), { untime: true });
await both('empty token: delegatecall', [{ to: TIMER, data: timed(E, dec, 2) }], timerOver(), { untime: true });
await both('empty token: staticcall', [{ to: TIMER, data: timed(E, dec, 1) }], timerOver(), { untime: true });
await both('empty token: callcode', [{ to: TIMER, data: timed(E, dec, 3) }], timerOver(), { untime: true });
await both('EOA delegated to factory: isB20(T)', [{ to: TIMER, data: timed(D, '0xfa19b927' + T.slice(2).padStart(64, '0')) }], timerOver({ [D]: { code: `0xef0100${F.slice(2)}` } }), { untime: true });
await both('EOA delegated to policy registry: policyExists(0)', [{ to: TIMER, data: timed(D, '0x330f5637' + '00'.repeat(32), 0, 0n, 100_000n) }], timerOver({ [D]: { code: `0xef0100${P.slice(2)}` } }), { untime: true });
const transfer0 = '0xa9059cbb' + USER.slice(2).padStart(64, '0') + '00'.repeat(32);
await both('staticcall token.transfer(USER,0)', [{ to: TIMER, data: timed(T, transfer0, 1, 0n, 100_000n) }], timerOver(), { untime: true });
await both('staticcall token.approve(USER,0)', [{ to: TIMER, data: timed(T, '0x095ea7b3' + USER.slice(2).padStart(64, '0') + '00'.repeat(32), 1, 0n, 100_000n) }], timerOver(), { untime: true });
