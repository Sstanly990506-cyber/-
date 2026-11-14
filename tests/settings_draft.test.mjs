import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
class Element {
  constructor() { this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.listeners = {}; this.attributes = {}; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  emit(name) { return this.listeners[name]?.({ currentTarget: this, preventDefault() {} }); }
  querySelector() { return this.button; }
  querySelectorAll() { return [this.button]; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
}
async function harness(reply = () => ({ ok: true, json: async () => ({ ok: true }) })) {
  const form = new Element(), title = new Element(); form.button = new Element(); form.button.textContent = '儲存';
  const els = { settingsForm: form, settingsAppTitle: title };
  const handlers = {};
  const document = { getElementById: id => els[id], querySelectorAll: () => [], documentElement: { style: { setProperty() {} } }, body: { dataset: {} } };
  const alerts = [];
  const context = vm.createContext({ document, window: { addEventListener: (name, fn) => { handlers[name] = fn; } }, alert: s => alerts.push(s), fetch: reply, console });
  const shared = new vm.SourceTextModule(source('shared.js'), { context });
  const busy = new vm.SourceTextModule(source('busy-action.js'), { context });
  const settings = new vm.SourceTextModule(source('settings.js'), { context });
  await settings.link(specifier => specifier.includes('busy-action') ? busy : shared);
  await settings.evaluate();
  const state = { settings: shared.namespace.getDefaultSettings(), userRole: 'viewer', authToken: 'A' };
  settings.namespace.bindSettingsEvents(state, async () => {}, () => settings.namespace.renderSettings(state));
  settings.namespace.renderSettings(state);
  return { form, title, state, settings: settings.namespace, handlers, alerts };
}

test('background render preserves typed draft and continues to reflect preview', async () => {
  const h = await harness();
  h.title.value = '新的系統名稱'; h.form.emit('input');
  h.state.settings.appTitle = '背景的設定'; h.settings.renderSettings(h.state);
  assert.equal(h.title.value, '新的系統名稱');
});

test('failed settings save keeps entered fields and does not replace committed state', async () => {
  const h = await harness(() => ({ ok: false, status: 409, json: async () => ({ error: '資料已變更' }) }));
  const original = h.state.settings.appTitle;
  h.title.value = '尚未完成的草稿'; h.form.emit('input');
  await h.form.emit('submit');
  h.settings.renderSettings(h.state);
  assert.equal(h.title.value, '尚未完成的草稿');
  assert.equal(h.state.settings.appTitle, original);
  assert.match(h.alerts[0], /儲存設定失敗/);
});

test('successful save clears dirty protection so future server changes are shown', async () => {
  const h = await harness();
  h.title.value = '我的設定'; h.form.emit('input');
  await h.form.emit('submit');
  assert.equal(h.state.settings.appTitle, '我的設定');
  h.state.settings.appTitle = '新的已儲存設定'; h.settings.renderSettings(h.state);
  assert.equal(h.title.value, '新的已儲存設定');
});

test('logout clears another session’s unsaved draft', async () => {
  const h = await harness();
  h.title.value = '前一個人的草稿'; h.form.emit('input');
  h.state.authToken = null; h.handlers['app:auth-changed']();
  h.state.authToken = 'B'; h.state.settings.appTitle = '新登入的設定'; h.settings.renderSettings(h.state);
  assert.equal(h.title.value, '新登入的設定');
});
