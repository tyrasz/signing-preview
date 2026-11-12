import { both, timed, timerOver, TIMER } from './h.ts';
const P = '0x8453000000000000000000000000000000000002', A = '0x8453000000000000000000000000000000000001', F = '0xb20f000000000000000000000000000000000000', T = '0xb200000000000000000000397293cb8cda9a10c5';
for (const [name, to] of [['policy', P], ['activation', A], ['factory', F], ['token', T]] as const) {
  for (const data of ['0x', '0x12', '0xdeadbeef']) await both(`${name} ${data}`, [{ to: TIMER, data: timed(to, data) }], timerOver(), { untime: true });
}
