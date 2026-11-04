import { previewRequest } from '../src/preview.ts';
import { StaticTokenRegistry } from '../src/chains.ts';
import { ALICE, buildSamples, mockHyperEvmRpc, mockHyperliquidInfo, mockSimulator } from '../mocks/data.ts';
import type { Dependencies, Preview, PreviewContext } from '../src/types.ts';

export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

export function mockDeps(): Dependencies {
  return { tokens: new StaticTokenRegistry(), simulator: mockSimulator(), hyperliquid: { mainnet: mockHyperliquidInfo() }, rpc: mockHyperEvmRpc() };
}

/** Preview a named mock sample with deterministic time. */
export async function sample(id: string, extra: PreviewContext = {}, deps = mockDeps()): Promise<Preview> {
  const s = buildSamples(NOW).find(x => x.id === id);
  if (!s) throw new Error('unknown sample ' + id);
  return previewRequest(s.request, { chainId: s.chainId, account: ALICE, now: NOW, ...s.context, ...extra }, deps);
}

export const codes = (p: Preview) => p.warnings.map(w => w.code);
export const detail = (p: Preview, label: string) => p.details.find(d => d.label === label)?.value;
