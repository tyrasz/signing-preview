import { withSigningPreview, remotePreview } from '/dist/interceptor.js';

const $ = id => document.getElementById(id);
// ?account=0x… lets the mock wallet stand in for any address, e.g. to preview a real position in live mode.
const ACCOUNT = new URLSearchParams(location.search).get('account')?.match(/^0x[0-9a-fA-F]{40}$/)?.[0] ?? '0xa11ce00000000000000000000000000000000001';
let samples = [];
let activeContext = {};

// A stand-in for any wallet: window.ethereum, an EIP-6963 provider, WalletConnect…
const mockWallet = {
  chainId: 42161,
  async request({ method }) {
    if (method === 'eth_chainId') return '0x' + this.chainId.toString(16);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ACCOUNT];
    if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32);
    if (method === 'wallet_sendCalls') return { id: '0x' + 'cd'.repeat(32) };
    return '0x' + '5e'.repeat(65);
  },
};

let pendingConfirm = null;
const provider = withSigningPreview(mockWallet, {
  preview: remotePreview('/v1/preview'),
  context: () => activeContext,
  confirm: preview => new Promise(resolve => { pendingConfirm = resolve; render(preview); }),
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ATTENTION = { none: 'No warnings', info: 'Note', caution: 'Review', danger: 'Danger' };

function renderBody(p) {
  const net = p.network ? `<span class="chip">${esc(p.network.name)}</span>` : '';
  const warnings = p.warnings.map(w => `<div class="warning ${w.severity}" role="${w.severity === 'danger' ? 'alert' : 'note'}"><strong>${esc(w.severity)}:</strong> ${esc(w.message)}</div>`).join('');
  const changes = p.assetChanges.length ? `<div class="changes">${p.assetChanges.map(c => `<div class="change ${c.direction}"><span>${c.direction === 'out' ? 'You send' : 'You receive'} <small>(${esc(c.basis.replace('_', ' '))})</small></span><span class="amt">${c.direction === 'out' ? '−' : '+'}${esc(c.amount)} ${esc(c.symbol)}${c.usd ? ` <small title="${esc(c.usdSource ?? '')}">≈ $${esc(c.usd)}</small>` : ''}</span></div>`).join('')}</div>` : '';
  const details = p.details.length ? `<dl>${p.details.map(d => `<dt>${esc(d.label)}</dt><dd>${/^0x[0-9a-f]{20,}$/i.test(d.value) ? `<code>${esc(d.value)}</code>` : esc(d.value)}</dd>`).join('')}</dl>` : '';
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const approvals = p.approvals?.length ? `<div class="changes">${p.approvals.map(a => `<div class="change approval${a.revoked ? ' revoked' : ''}"><span>${a.revoked ? 'Permission removed' : 'Permission left in place'} <small>(${a.direct ? 'this call' : 'set along the way'})</small></span><span class="amt">${esc(short(a.spender))} → ${esc(a.allowance === 'unlimited' ? `unlimited ${a.symbol ?? ''}` : a.allowance)}</span></div>`).join('')}</div>` : '';
  const sim = p.simulation ? `<div class="network">Simulation: <span class="chip">${esc(p.simulation.status)}</span>${p.simulation.gasUsed ? `<span class="chip">gas ${esc(p.simulation.gasUsed)}</span>` : ''}</div>` : '';
  const calls = p.calls ? p.calls.map((c, i) => `<div class="call"><div class="network">Call ${i + 1}</div><div class="title" style="font-size:15px">${esc(c.title)}</div>${c.details.length ? `<dl>${c.details.map(d => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd>`).join('')}</dl>` : ''}${renderTrace(c.trace)}</div>`).join('') : '';
  return `
    <div class="network">${net}<span class="chip">${esc(p.method)}</span><span class="chip">decoded: ${esc(p.decoding.status)}</span><span class="badge ${p.attention}">${ATTENTION[p.attention]}</span></div>
    <div class="title">${esc(p.title)}</div>
    <p class="summary">${esc(p.summary)}</p>
    ${warnings}${changes}${approvals}${sim}${details}${calls}${renderTrace(p.trace)}
    ${p.decoding.notes.length ? `<div class="network">${p.decoding.notes.map(esc).join(' ')}</div>` : ''}`;
}

// The call trace (context.trace): each call on a line, indented under its caller, with its events; then what changed.
function renderTrace(t) {
  if (!t) return '';
  const pad = n => '  '.repeat(n);
  const lines = t.calls.flatMap(c => [
    `${pad(c.depth)}<span class="${c.error ? 'failed' : ''}${c.named === 'signature' ? ' guess' : ''}">${esc(c.text ?? c.to ?? '')}</span>${c.returns ? ` → ${esc(c.returns.map(r => r.value).join(', ').slice(0, 80))}` : ''} <span class="gas">${esc(Number(c.gasUsed).toLocaleString('en-US'))} gas</span>`,
    ...(c.events ?? []).map(e => `${pad(c.depth + 1)}<span class="event">emits ${esc(e.label ?? e.address.slice(0, 10) + '…')}.${esc(e.name ?? e.topics[0]?.slice(0, 10) ?? 'anonymous')}(${esc((e.args ?? []).map(a => `${a.name ? a.name + ': ' : ''}${a.value}`).join(', ').slice(0, 160))})</span>`),
  ]);
  const changes = (t.stateChanges ?? []).map(s => `${esc(s.label ?? s.address)}: ${[s.balance && esc(s.balance.change), s.nonce && `nonce ${esc(s.nonce.before)} → ${esc(s.nonce.after)}`, s.code && 'code set', s.storage && `${s.storageSlots ?? s.storage.length} storage slot${(s.storageSlots ?? s.storage.length) === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`);
  return `<details open><summary>Call trace: ${t.totalCalls ?? t.calls.length} call${(t.totalCalls ?? t.calls.length) === 1 ? '' : 's'}${t.truncated ? ` (the first ${t.calls.length} shown)` : ''}, from ${esc(t.source)}</summary>
    ${t.note ? `<div class="warning caution" role="note">${esc(t.note)}</div>` : ''}<div class="trace">${lines.join('\n')}</div>
    ${changes.length ? `<div class="network">State changed: ${changes.join('; ')}</div>` : ''}</details>`;
}

function render(p) {
  const el = $('preview');
  el.className = 'wallet';
  el.innerHTML = `${renderBody(p)}
    <div class="actions"><button class="secondary" id="reject">Reject</button><button class="primary" id="approve">${p.attention === 'danger' ? 'Sign anyway' : 'Approve'}</button></div>
    <details><summary>Preview JSON</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`;
  $('approve').onclick = () => settle(true);
  $('reject').onclick = () => settle(false);
}

function settle(ok) {
  pendingConfirm?.(ok);
  pendingConfirm = null;
  $('approve').disabled = $('reject').disabled = true;
}

function log(text) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').prepend(line);
}

async function send(request, chainId, context = {}) {
  if (pendingConfirm) settle(false);
  mockWallet.chainId = chainId;
  activeContext = $('trace').checked ? { ...context, trace: true } : context;
  $('preview').className = 'empty';
  $('preview').textContent = 'Previewing…';
  try {
    const result = await provider.request(request);
    log(`${request.method} → wallet returned ${JSON.stringify(result).slice(0, 42)}…`);
  } catch (error) {
    log(`${request.method} → ${error.code === 4001 ? 'rejected by user (4001)' : 'error: ' + error.message}`);
  }
}

async function init() {
  // The server says whether previews come from mock data or live chains (SIGNING_PREVIEW_MODE=live).
  fetch('/demo/config.json').then(r => r.json()).then(c => {
    if (c.data === 'live') $('data-note').textContent = 'Previews use live chain data: real balances, prices, contracts and simulations. The wallet itself is a mock and signs nothing; the sample requests use mock accounts unless ?account=0x… is set.';
  }).catch(() => {});
  samples = await (await fetch('/v1/samples')).json();
  const groups = [...new Set(samples.map(s => s.group))];
  $('samples').innerHTML = groups.map(g => `<div class="group"><h3>${esc(g)}</h3>${samples.filter(s => s.group === g).map(s => `<button class="sample" data-id="${esc(s.id)}">${esc(s.label)}</button>`).join('')}</div>`).join('');
  $('samples').addEventListener('click', e => {
    const button = e.target.closest('.sample');
    if (!button) return;
    document.querySelectorAll('.sample.active').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    const s = samples.find(x => x.id === button.dataset.id);
    $('custom').value = JSON.stringify(s.request, null, 2);
    $('chain').value = String(s.chainId);
    send(s.request, s.chainId, s.context);
  });
  $('custom').value = JSON.stringify(samples[0].request, null, 2);
  $('send').onclick = () => {
    let request;
    try { request = JSON.parse($('custom').value); } catch { return log('custom request is not valid JSON'); }
    send(request, Number($('chain').value));
  };
}
init();
