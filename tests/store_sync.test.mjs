import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

async function harness(fetch) {
  const context = vm.createContext({
    fetch, console, setTimeout, clearTimeout, setInterval,
    queueMicrotask: () => {},
    document: { getElementById: () => null },
    localStorage: { getItem: () => '{invalid', setItem: () => {} },
  });
  const shared = new vm.SyntheticModule(['formatTs', 'getTodayText', 'getDefaultSettings', 'mergeSettings'], function () {
    this.setExport('formatTs', () => 'now');
    this.setExport('getTodayText', () => '2026-10-03');
    this.setExport('getDefaultSettings', () => ({}));
    this.setExport('mergeSettings', (value) => value);
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/store.js', import.meta.url), 'utf8'), { context });
  await module.link(() => shared);
  await module.evaluate();
  const store = module.namespace;
  store.configureStore({ refreshFn: () => {}, syncUiFn: () => {} });
  store.setAuthToken('first-account');
  store.state.allowedViews = ['customersView'];
  store.hydrateBootstrap({ initialPages: { customers: { items: [{ id: 'c1', name: 'original' }] } } });
  return store;
}

const response = (data = {}) => ({ ok: true, json: async () => data });

test('consecutive edits during a write are sent in order', async () => {
  let release;
  const calls = [];
  const store = await harness(async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return response();
  });
  store.state.customers[0].name = 'first edit';
  const first = store.saveState();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  store.state.customers[0].name = 'second edit';
  const second = store.saveState();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls.map((row) => row.name), ['first edit', 'second edit']);
  await store.saveState();
  assert.equal(calls.length, 2);
});

test('remote changes cannot overwrite an unsaved local edit', async () => {
  const store = await harness(async () => response({ cursor: 1, changes: [{ entity: 'customers', id: 'c1', data: { name: 'remote' }, updatedAt: 1 }] }));
  store.state.customers[0].name = 'local edit';
  await store.pullServerState();
  assert.equal(store.state.customers[0].name, 'local edit');
});

test('switching accounts discards an old in-flight page response', async () => {
  let release;
  const store = await harness(async () => {
    await new Promise((resolve) => { release = resolve; });
    return response({ items: [{ id: 'old', name: 'private old account' }] });
  });
  const pending = store.loadEntityPage('customers');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  store.setAuthToken('second-account');
  release();
  await pending;
  assert.equal(store.state.customers.length, 0);
});

test('invalid saved UI JSON does not block initialization', async () => {
  const store = await harness(async () => response());
  assert.doesNotThrow(() => store.initializeStore());
});
