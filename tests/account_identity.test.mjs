import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

test('authentication events observe only the current account identity', async () => {
  const observed = [];
  let store;
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: async () => { throw new Error('unexpected fetch'); },
    document: { getElementById: () => null },
    window: { dispatchEvent: event => observed.push([event.type, store.state.authToken, store.state.accountId]) },
    Event: class { constructor(type) { this.type = type; } },
  });
  const shared = new vm.SyntheticModule(['formatTs', 'getTodayText', 'getDefaultSettings', 'mergeSettings'], function () {
    this.setExport('formatTs', () => 'now');
    this.setExport('getTodayText', () => 'today');
    this.setExport('getDefaultSettings', () => ({}));
    this.setExport('mergeSettings', value => value);
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/store.js', import.meta.url), 'utf8'), { context });
  await module.link(() => shared);
  await module.evaluate();
  store = module.namespace;

  store.setAuthToken('token-a', 'id-a');
  store.state.orders = [{ id: 'private-order' }];
  store.setAuthToken('token-b', 'id-b');
  assert.equal(store.state.orders.length, 0);
  store.setAuthToken(null, 'id-b');
  store.setAuthToken('demo-token');
  assert.deepEqual(observed, [
    ['app:auth-changed', 'token-a', 'id-a'],
    ['app:auth-changed', 'token-b', 'id-b'],
    ['app:auth-changed', null, null],
    ['app:auth-changed', 'demo-token', null],
  ]);
});
