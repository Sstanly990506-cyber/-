import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

async function harness(fetch) {
  const elements = new Map([['aiCorrectionsTbody', {innerHTML: ''}], ['aiCorrectionsSummary', {textContent: ''}]]);
  const exports = [];
  const context = vm.createContext({fetch, Date});
  const shared = new vm.SyntheticModule(['$', 'downloadCsv', 'escapeHtml'], function() {
    this.setExport('$', id => elements.get(id));
    this.setExport('downloadCsv', (name, rows) => exports.push({name, rows}));
    this.setExport('escapeHtml', value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  }, {context});
  const module = new vm.SourceTextModule(fs.readFileSync(new URL('../js/orders-ai-corrections.js', import.meta.url), 'utf8'), {context});
  await module.link(() => shared); await module.evaluate();
  return {api: module.namespace, elements, exports};
}

test('AI correction records load, escape unsafe content and export the same information', async () => {
  const calls = [];
  const h = await harness(async (url, options) => {
    calls.push({url, authorization: options.headers.Authorization});
    return {ok: true, json: async () => ({ok: true, items: [{id:'abc', confidence:0.8, reportedBy:'<test>', changes:{orderNumber:{wrong:'old', correct:'new'}}}]})};
  });
  await h.api.loadAiCorrections({authToken:'token'});
  assert.equal(calls[0].url, '/api/data/aiCorrections?page=1&pageSize=100');
  assert.equal(calls[0].authorization, 'Bearer token');
  assert.match(h.elements.get('aiCorrectionsSummary').textContent, /1 筆修正案例，1 個欄位/);
  assert.match(h.elements.get('aiCorrectionsTbody').innerHTML, /&lt;test&gt;/);
  assert.match(h.elements.get('aiCorrectionsTbody').innerHTML, /80%/);
  h.api.exportAiCorrections();
  assert.equal(h.exports[0].name, 'AI-修正中心.csv');
  assert.deepEqual(Array.from(h.exports[0].rows[1]).slice(0, 4), ['工單編號', 'old', 'new', '80%']);
});

test('disabling AI tools prevents fetch; errors remain visible to the caller', async () => {
  let calls = 0;
  const h = await harness(async () => {calls++; return {ok: false, status:503, json: async () => ({error:'network'})};});
  await h.api.loadAiCorrections({settings:{moduleInternals:{orders:{showAiTools:false}}}});
  assert.equal(calls, 0);
  await assert.rejects(h.api.loadAiCorrections({}), /network/);
  assert.equal(calls, 1);
});
