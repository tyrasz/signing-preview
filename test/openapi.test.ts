// The OpenAPI document is hand-written; these tests keep it honest. Every sample request is sent through the real
// HTTP server and each response must match the documented schema exactly (unknown fields are rejected), so the spec
// can't drift from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Ajv2020Module from 'ajv/dist/2020.js';
import { createPreviewServer, openApiDocument } from '../src/server.ts';
import { buildSamples } from '../mocks/data.ts';
import { mockDeps, NOW } from './helpers.ts';

const Ajv2020 = (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module;
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object, k?: string): void; getSchema(k: string): ((d: unknown) => boolean) & { errors?: unknown[] } | undefined; compile(s: object): ((d: unknown) => boolean) & { errors?: unknown[] } })({ strict: false, allErrors: true });
ajv.addSchema({ ...spec, $id: 'signing-preview-openapi' });
const validator = (name: string) => {
  const v = ajv.getSchema(`signing-preview-openapi#/components/schemas/${name}`);
  assert.ok(v, `schema ${name}`);
  return (data: unknown, label: string) => assert.ok(v(data), `${label} does not match ${name}: ${JSON.stringify(v.errors?.slice(0, 3))}`);
};

test('openapi.json is a valid OpenAPI 3.1 document, and the server serves it', async () => {
  // ajv doesn't resolve the meta-schema's `$dynamicRef: "#meta"` (its anchor isn't at the root). The base meta-schema
  // treats Schema Objects as any object or boolean, so that is substituted for the dynamic reference.
  const raw = readFileSync(new URL('../node_modules/@apidevtools/openapi-schemas/schemas/v3.1/schema.json', import.meta.url), 'utf8');
  const meta = JSON.parse(raw.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"'));
  meta.$defs.schema = { type: ['object', 'boolean'] };
  const check = new (Ajv2020 as unknown as new (o: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown[] } })({ strict: false, allErrors: true }).compile(meta);
  assert.ok(check(spec), JSON.stringify(check.errors?.slice(0, 5)));
  assert.deepEqual(openApiDocument(), spec);
  assert.equal(spec.info.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'spec and package versions agree');
});

test('The examples in the spec match their schemas', () => {
  const op = spec.paths['/v1/preview'].post;
  for (const [name, ex] of Object.entries(op.requestBody.content['application/json'].examples as Record<string, { value: unknown }>)) validator('PreviewRequest')(ex.value, `request example ${name}`);
  for (const [name, ex] of Object.entries(op.responses[200].content['application/json'].examples as Record<string, { value: unknown }>)) validator('Preview')(ex.value, `response example ${name}`);
});

test('Every sample request, sent through the HTTP server, returns a response that matches the spec', async () => {
  const server = createPreviewServer({ deps: mockDeps(), samples: () => buildSamples(NOW) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const samples = await (await fetch(`${base}/v1/samples`)).json() as { id: string; request: unknown; context?: object; chainId?: number }[];
    assert.ok(samples.length >= 40, `${samples.length} samples`);
    const isPreview = validator('Preview'), isSample = validator('Sample');
    const kinds = new Set<string>();
    for (const s of samples) {
      isSample(s, `sample ${s.id}`);
      const res = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: s.request, context: { chainId: s.chainId, ...s.context } }) });
      assert.equal(res.status, 200, s.id);
      const body = await res.json() as { kind: string };
      isPreview(body, `preview of ${s.id}`);
      kinds.add(body.kind);
    }
    assert.deepEqual([...kinds].sort(), ['batch', 'message', 'transaction', 'typed_data']);
    // A non-signing method is a preview too.
    const other = await (await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { method: 'eth_blockNumber' } }) })).json();
    isPreview(other, 'eth_blockNumber');

    const isError = validator('Error');
    const bad = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { method: 'eth_sendTransaction', params: [{ to: '0x1' }] } }) });
    assert.equal(bad.status, 400); isError(await bad.json(), '400');
    const notJson = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(notJson.status, 400); isError(await notJson.json(), '400 invalid JSON');
    const media = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(media.status, 415); isError(await media.json(), '415');
    const big = await fetch(`${base}/v1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { method: 'personal_sign', params: ['x'.repeat(300_000)] } }) });
    assert.equal(big.status, 413); isError(await big.json(), '413');
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 404); isError(await missing.json(), '404');
    assert.deepEqual(await (await fetch(`${base}/v1/health`)).json(), { status: 'ok' });
    assert.deepEqual(await (await fetch(`${base}/v1/openapi.json`)).json(), spec);
  } finally {
    server.close();
  }
});
