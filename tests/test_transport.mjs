import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/local-ai-transport.js', import.meta.url), 'utf8');
const { createAiTransport, SITE_ORIGIN, COMPANION_ORIGIN } = await import('data:text/javascript,' + encodeURIComponent(source));

function fixture() {
  const cloud = [], local = [];
  let gate = null;
  const bridge = createAiTransport({
    origin: SITE_ORIGIN,
    siteRequest: async (path, payload) => {
      cloud.push({ path, payload });
      return path === 'ticket' ? { ok: true, ticket: 'sqai1.FAKE_AI_ONLY' } : { ok: true, answer: 'data' };
    },
    fetchFn: async (url, options) => {
      local.push({ url, options });
      assert(url.startsWith(COMPANION_ORIGIN + '/'));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer sqai1.FAKE_AI_ONLY');
      if (url.endsWith('/check') && gate) await gate;
      const data = url.endsWith('/pair') ? { pairId: 'fake-pair', code: '000000' } : url.endsWith('/pair/status') ? { status: 'connected', capability: 'fake-capability' } : { answer: 'local-only-answer' };
      return { ok: true, status: 200, json: async () => ({ ok: true, ...data }) };
    },
  });
  return { bridge, cloud, local, setGate: value => { gate = value; } };
}

const f = fixture();
await assert.rejects(f.bridge.request('chat', { mode: 'general', question: 'private question', history: [] }));
assert.equal(f.cloud.length, 0);
const pair = await f.bridge.begin();
await f.bridge.poll(pair.pairId);
for (const mode of ['general', 'documents']) {
  await f.bridge.request('chat', { mode, question: 'PRIVATE_LOCAL_DOCUMENT', history: [], entity: 'orders' });
}
assert.deepEqual(f.cloud, [{ path: 'ticket', payload: {} }]);
const request = f.local.find(row => row.url.endsWith('/chat'));
assert(!JSON.parse(request.options.body).entity);
await f.bridge.request('chat', { mode: 'data', question: 'DEMO-001', entity: 'orders', history: [] });
assert.equal(f.cloud.at(-1).payload.question, 'DEMO-001');
assert(!JSON.stringify(f.cloud).includes('PRIVATE_LOCAL_DOCUMENT'));
f.bridge.reset();
await assert.rejects(f.bridge.request('preview', { recordId: 'fake', note: 'new' }));

const race = fixture();
await race.bridge.begin();
await race.bridge.poll('fake-pair');
let release;
race.setGate(new Promise(resolve => { release = resolve; }));
const pending = race.bridge.request('confirm', { proposalId: 'fake', confirmed: true });
race.bridge.reset();
release();
await assert.rejects(pending);
assert(!race.cloud.some(call => call.path === 'confirm'));

let contacted = false;
const unsupported = createAiTransport({ origin: 'https://other.example', siteRequest: async () => { contacted = true; } });
await assert.rejects(unsupported.request('chat', { mode: 'general', question: 'private' }));
assert.equal(contacted, false);
console.log('PASS: transport routing, scoped tickets, no cloud prompt, pairing, logout race');
