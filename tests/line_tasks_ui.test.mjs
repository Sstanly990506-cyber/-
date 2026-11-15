import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../js/notifications.js', import.meta.url), 'utf8');
class Element {
  innerHTML = ''; textContent = ''; value = ''; disabled = false; listeners = {};
  addEventListener(type, fn) { this.listeners[type] = fn; }
  emit(type, event = {}) { return this.listeners[type]?.({ target: this, ...event }); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(fetch) {
  const list = new Element(), filter = new Element(); filter.value = 'pending';
  const elements = new Map([['lineTaskList', list], ['lineTaskFilter', filter]]);
  const timers = new Map(), alerts = []; let next = 0;
  const state = { authToken: 'A', user: '員工甲', systemEvents: [] };
  const context = vm.createContext({ fetch, console, alert: message => alerts.push(message),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    location: { origin: 'https://example.com' } });
  const shared = new vm.SyntheticModule(['$', 'formatTs', 'downloadCsv', 'escapeHtml'], function () {
    this.setExport('$', id => elements.get(id)); this.setExport('formatTs', String); this.setExport('downloadCsv', () => {});
    this.setExport('escapeHtml', value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])));
  }, { context });
  const mod = new vm.SourceTextModule(source, { context }); await mod.link(() => shared); await mod.evaluate();
  mod.namespace.bindNotificationEvents(state, () => {}, () => {});
  const run = async () => { while(timers.size) { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); await settle(); } await settle(); };
  return { state, list, filter, alerts, render: () => mod.namespace.renderNotifications(state), run };
}
const response = data => ({ ok: true, json: async () => data });
const task = (id, status='pending') => ({ id, kind:'line_task', taskStatus:status, message:`任務 ${id}`, groupLabel:'群組 G', count:2, _updatedAt:10, history:[] });

test('LINE task list reads every page and can switch between pending and handled', async () => {
  const calls = [];
  const h = await harness(async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer A');
    const page = new URL('https://example.com' + url).searchParams.get('page');
    return response({ok:true,pages:2,items:page==='1'?[task('first'),task('handled','done')]:[task('second')]});
  });
  h.render(); await h.run();
  assert.equal(calls.length, 2); assert.match(h.list.innerHTML, /任務 first/); assert.match(h.list.innerHTML, /任務 second/);
  assert.doesNotMatch(h.list.innerHTML, /任務 handled/); assert.match(h.list.innerHTML, /詢問 2 次/);
  h.filter.value='done'; h.filter.emit('change'); assert.match(h.list.innerHTML, /任務 handled/); assert.doesNotMatch(h.list.innerHTML, /標記已處理/);
});

test('marking handled sends the viewed version and a conflict refreshes without false success', async () => {
  const writes = []; let reads = 0;
  const h = await harness(async (url, options) => {
    if (options.method === 'PUT') { writes.push(JSON.parse(options.body)); return {ok:false,status:409,json:async()=>({error:'conflict'})}; }
    reads++; return response({ok:true,pages:1,items:[task('one')]});
  });
  h.render(); await h.run();
  const button = { disabled:false, textContent:'標記已處理', dataset:{resolveLineTask:'one'}, closest(){return this;} };
  await h.list.emit('click', {target:button});
  assert.equal(writes.length, 1); assert.equal(writes[0]._expectedVersion, 10); assert.equal(writes[0].taskStatus, 'done');
  assert.equal(writes[0].resolvedBy, '員工甲'); assert.match(h.alerts[0], /已更新/); assert.equal(reads, 2);
  assert.equal(button.disabled, false);
});

test('a pending response from a different account cannot reveal its tasks', async () => {
  let release;
  const h = await harness(async (url, options) => {
    if(options.headers.Authorization === 'Bearer A') { await new Promise(resolve => { release=resolve; }); return response({ok:true,pages:1,items:[task('private')]}); }
    return response({ok:true,pages:1,items:[task('public')]});
  });
  h.render(); const pending = h.run(); while(!release) await settle();
  h.state.authToken='B'; h.render(); release(); await pending; await h.run();
  assert.doesNotMatch(h.list.innerHTML, /private/); assert.match(h.list.innerHTML, /public/);
});
