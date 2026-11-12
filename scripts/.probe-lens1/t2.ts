import { both, timed, timerOver, TIMER } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', F = '0xb20f000000000000000000000000000000000000', T = '0xb200000000000000000000397293cb8cda9a10c5';
const SHA = '0x0000000000000000000000000000000000000002';
// sha256 moved onto the token: which runs at the token's address?
await both('sha256 moved onto token, symbol()', [{ to: TIMER, data: timed(T, '0x95d89b41') }], timerOver({ [SHA]: { movePrecompileToAddress: T } }), { untime: true });
await both('sha256 moved onto policy registry', [{ to: TIMER, data: timed(P, '0x330f5637' + '00'.repeat(32)) }], timerOver({ [SHA]: { movePrecompileToAddress: P } }), { untime: true });
await both('sha256 moved onto factory, isB20(T)', [{ to: TIMER, data: timed(F, '0xfa19b927' + T.slice(2).padStart(64, '0')) }], timerOver({ [SHA]: { movePrecompileToAddress: F } }), { untime: true });
// override code at the token's address
await both('code override on token, symbol()', [{ to: TIMER, data: timed(T, '0x95d89b41') }], timerOver({ [T]: { code: '0x602a60005260206000f3' } }), { untime: true });
await both('code override on factory, isB20(T)', [{ to: TIMER, data: timed(F, '0xfa19b927' + T.slice(2).padStart(64, '0')) }], timerOver({ [F]: { code: '0x602a60005260206000f3' } }), { untime: true });
