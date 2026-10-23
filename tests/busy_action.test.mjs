import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const busySource = fs.readFileSync(new URL('../js/busy-action.js', import.meta.url), 'utf8');
const settingsSource = fs.readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  disabled = false;
  textContent = '';
  value = '';
  attributes = new Map();
  listeners = new Map();
  children = [];
  resetCount = 0;
  constructor(text = '') { this.textContent = text; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name, extra = {}) {
    return this.listeners.get(name)?.({ currentTarget: this, target: this, preventDefault() {}, ...extra });
  }
  querySelector(selector) { return selector === 'button[type="submit"]' ? this.button : null; }
  querySelectorAll() { return this.children; }
  reset() { this.resetCount++; }
}

async function busyModule(context = vm.createContext({})) {
  const module = new vm.SourceTextModule(busySource, { context });
  await module.link(() => { throw new Error('Unexpected import'); });
  await module.evaluate();
  return module;
}

test('slow operation immediately shows processing and accepts only one of many clicks', async () => {
  const { createBusyAction } = (await busyModule()).namespace;
  const run = createBusyAction(), gate = deferred(), button = new Element('儲存權限');
  let calls = 0;
  const task = () => { calls++; return gate.promise; };
  const pending = run({ button, task });
  assert.equal(button.textContent, '處理中…');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  for (let i = 0; i < 20; i++) await run({ button, task });
  assert.equal(calls, 1);
  gate.resolve('done');
  assert.equal(await pending, 'done');
  assert.equal(button.textContent, '儲存權限');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
});

test('failure unlocks for retry, restores disabled controls, and does not lock unrelated actions', async () => {
  const { createBusyAction } = (await busyModule()).namespace;
  const run = createBusyAction(), gate = deferred(), button = new Element('儲存');
  const input = new Element(), alreadyDisabled = new Element();
  alreadyDisabled.disabled = true;
  const pending = run({ button, controls: [button, input, alreadyDisabled], task: () => gate.promise });
  assert.equal(input.disabled, true);
  let otherRan = false;
  await createBusyAction()({ button: new Element('移動'), task: () => { otherRan = true; } });
  assert.equal(otherRan, true);
  const rejected = assert.rejects(pending, /offline/);
  gate.reject(new Error('offline'));
  await rejected;
  assert.equal(input.disabled, false);
  assert.equal(alreadyDisabled.disabled, true);
  assert.equal(button.textContent, '儲存');
  let retried = false;
  await run({ button, task: () => { retried = true; } });
  assert.equal(retried, true);
});

test('synchronous failures and canceled tasks also release the latch', async () => {
  const { createBusyAction } = (await busyModule()).namespace;
  const run = createBusyAction(), button = new Element('還原');
  await assert.rejects(run({ button, task: () => { throw new Error('bad file'); } }), /bad file/);
  await run({ button, task: () => undefined });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '還原');
});

async function settingsHarness(request) {
  const elements = new Map();
  const add = (id, text) => { const element = new Element(text); elements.set(id, element); return element; };
  const list = add('accountPermissionsList');
  const refresh = add('refreshAccountsBtn', '刷新帳號');
  const permissionButton = new Element('儲存權限'), role = new Element();
  role.value = 'ops';
  const checked = new Element(); checked.value = 'ordersView'; checked.checked = true;
  const otherDraft = new Element(); otherDraft.checked = false;
  const row = {
    dataset: { accountPermissionRow: 'user-1' },
    outerHTML: '',
    querySelector: () => role,
    querySelectorAll: () => [checked],
  };
  permissionButton.closest = selector => selector === '[data-save-account-permissions]' ? permissionButton : row;
  const form = add('createAccountForm'); form.button = new Element('新增帳戶');
  for (const id of ['newAccountUsername', 'newAccountDisplay', 'newAccountPassword', 'newAccountPasswordConfirm']) add(id).value = id.includes('Password') ? 'password123' : 'new-user';
  form.children = [form.button, ...['newAccountUsername', 'newAccountPassword', 'newAccountPasswordConfirm'].map(id => elements.get(id))];
  const financeForm = add('financePasswordForm'); financeForm.button = new Element('更新財經密碼');
  add('newFinancePassword').value = add('newFinancePasswordConfirm').value = 'password456';
  financeForm.children = [financeForm.button, elements.get('newFinancePassword'), elements.get('newFinancePasswordConfirm')];
  const clear = add('clearTestDataBtn', '清空測試資料');
  const requests = [], alerts = [];
  const document = { querySelectorAll: () => [permissionButton, role, checked, otherDraft, refresh, ...form.children] };
  const context = vm.createContext({
    console, document,
    alert: message => alerts.push(message),
    window: { prompt: () => null },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return body.action === 'list_accounts' ? { ok: true, json: async () => ({ ok: true, accounts: [] }) } : request(body);
    },
  });
  const shared = new vm.SyntheticModule(['$', 'MODULE_DEFINITIONS', 'applyRuntimeBranding', 'getDefaultSettings', 'getModuleMeta', 'mergeSettings', 'isModuleEnabledInSettings'], function () {
    this.setExport('$', id => elements.get(id));
    this.setExport('MODULE_DEFINITIONS', [{ id: 'ordersView', label: '工單' }]);
    for (const name of ['applyRuntimeBranding', 'getDefaultSettings', 'getModuleMeta', 'mergeSettings', 'isModuleEnabledInSettings']) this.setExport(name, () => ({}));
  }, { context });
  const busy = await busyModule(context);
  const settings = new vm.SourceTextModule(settingsSource, { context });
  await settings.link(specifier => specifier.includes('busy-action') ? busy : shared);
  await settings.evaluate();
  settings.namespace.bindSettingsEvents({ userRole: 'admin', authToken: 'token' }, () => {}, () => {});
  await settle(); // Finish the initial account list request before user interaction.
  return { elements, list, refresh, permissionButton, row, role, checked, otherDraft, form, financeForm, clear, requests, alerts };
}

test('permission save sends once while slow, blocks refresh races, and preserves other account drafts', async () => {
  const gate = deferred();
  const h = await settingsHarness(() => gate.promise);
  const pending = h.list.emit('click', { target: h.permissionButton });
  assert.equal(h.permissionButton.textContent, '處理中…');
  assert.equal(h.role.disabled, true);
  for (let i = 0; i < 10; i++) await h.list.emit('click', { target: h.permissionButton });
  await h.refresh.emit('click');
  await h.form.emit('submit'); // Enter/submit events cannot bypass the shared guard.
  assert.equal(h.requests.length, 2); // initial load + one save
  assert.equal(h.requests[1].action, 'update_account_permissions');
  assert.deepEqual([...h.requests[1].allowedViews], ['ordersView']);
  gate.resolve({ ok: true, json: async () => ({ ok: true, account: { id: 'user-1', username: 'user', role: 'ops', allowedViews: ['ordersView'] } }) });
  await pending;
  assert.match(h.row.outerHTML, /data-account-permission-row="user-1"/);
  assert.equal(h.otherDraft.checked, false);
  assert.equal(h.otherDraft.disabled, false);
  assert.equal(h.requests.length, 2); // saving does not reload unrelated account rows
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /帳號權限已更新/);
});

test('permission error keeps selections, restores controls, and allows a deliberate retry', async () => {
  const h = await settingsHarness(async () => ({ ok: false, status: 503, json: async () => ({ error: '暫時離線' }) }));
  await h.list.emit('click', { target: h.permissionButton });
  assert.equal(h.permissionButton.disabled, false);
  assert.equal(h.permissionButton.textContent, '儲存權限');
  assert.equal(h.role.value, 'ops');
  assert.equal(h.checked.checked, true);
  assert.equal(h.row.outerHTML, '');
  assert.match(h.alerts[0], /更新帳號權限失敗：暫時離線/);
  await h.list.emit('click', { target: h.permissionButton });
  assert.equal(h.requests.filter(row => row.action === 'update_account_permissions').length, 2);
});

test('new account Enter submissions cannot duplicate a pending request', async () => {
  const gate = deferred();
  const h = await settingsHarness(() => gate.promise);
  h.list.insertAdjacentHTML = () => {};
  const pending = h.form.emit('submit');
  for (let i = 0; i < 10; i++) await h.form.emit('submit');
  assert.equal(h.requests.filter(row => row.action === 'create_account').length, 1);
  assert.equal(h.form.button.textContent, '處理中…');
  gate.resolve({ ok: true, json: async () => ({ ok: true, account: { id: 'user-2', role: 'ops' } }) });
  await pending;
  assert.equal(h.form.resetCount, 1);
  assert.equal(h.form.button.disabled, false);
  assert.match(h.alerts[0], /帳戶已新增/);
});

test('password changes show processing through the response and permit retry after failure', async () => {
  const gate = deferred();
  const h = await settingsHarness(() => gate.promise);
  const pending = h.financeForm.emit('submit');
  await h.financeForm.emit('submit');
  assert.equal(h.financeForm.button.textContent, '處理中…');
  assert.equal(h.requests.filter(row => row.action === 'change_finance_password').length, 1);
  gate.reject(new Error('offline'));
  await pending;
  assert.equal(h.financeForm.button.disabled, false);
  assert.equal(h.financeForm.resetCount, 0);
  assert.equal(h.elements.get('newFinancePassword').value, 'password456');
  assert.match(h.alerts[0], /更改財經密碼失敗/);
});

test('canceling clear-data confirmation restores button without an error or write', async () => {
  const h = await settingsHarness(() => { throw new Error('unexpected request'); });
  await h.clear.emit('click');
  assert.equal(h.requests.length, 1);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.clear.disabled, false);
});
