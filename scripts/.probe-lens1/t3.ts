import { both, timed, timerOver, TIMER } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', F = '0xb20f000000000000000000000000000000000000', T = '0xb200000000000000000000397293cb8cda9a10c5';
const X = '0x00000000000000000000000000000000000beef1';
await both('token moved away to X: call T symbol, X symbol', [{ to: TIMER, data: timed(T, '0x95d89b41') }, { to: TIMER, data: timed(X, '0x95d89b41') }], timerOver({ [T]: { movePrecompileToAddress: X } }), { untime: true });
await both('factory moved away to X: isB20(T) at F, at X', [{ to: TIMER, data: timed(F, '0xfa19b927' + T.slice(2).padStart(64, '0')) }, { to: TIMER, data: timed(X, '0xfa19b927' + T.slice(2).padStart(64, '0')) }], timerOver({ [F]: { movePrecompileToAddress: X } }), { untime: true });
