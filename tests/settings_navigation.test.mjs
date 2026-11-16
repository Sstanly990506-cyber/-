import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function setup() {
  class Element {
    constructor(dataset = {}) { this.dataset = dataset; this.hidden = false; this.listeners = {}; this.textContent = ''; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    focus() { this.focused = true; }
    dispatchEvent(event) { this.events.push(event); if (this.cancel) event.preventDefault(); return !event.defaultPrevented; }
    click(target) {
      const event = { target, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      this.listeners.click?.(event); return event;
    }
  }
  class CustomEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); this.defaultPrevented = false; }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  const sections = ['company', 'modules', 'accounts', 'maintenance', 'company modules accounts']
    .map(value => new Element({ settingsSection: value }));
  const root = new Element(); root.querySelectorAll = () => sections;
  const form = new Element(); form.events = [];
  const elements = { settingsView: root, settingsForm: form, settingsCategoryHome: new Element(),
    settingsCategoryHeading: new Element(), settingsCategoryTitle: new Element(), settingsBtn: new Element() };
  const document = { getElementById: id => elements[id] };
  const context = vm.createContext({ document, CustomEvent });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/settings-navigation.js', import.meta.url), 'utf8'), { context });
  await module.link(() => { throw new Error('unexpected import'); }); await module.evaluate();
  module.namespace.bindSettingsNavigation();
  const target = (selector, category) => ({ closest: query => query === selector ? { dataset: { settingsCategoryOpen: category } } : null });
  return { elements, root, form, sections, target };
}

test('category navigation keeps hidden sections mounted and shows only the selected section', async () => {
  const h = await setup();
  const field = { value: '未儲存的輸入' }; h.sections[1].field = field;
  assert.equal(h.elements.settingsCategoryHome.hidden, false);
  assert.ok(h.sections.every(section => section.hidden));
  h.root.click(h.target('[data-settings-category-open]', 'modules'));
  assert.equal(h.elements.settingsCategoryHome.hidden, true);
  assert.equal(h.elements.settingsCategoryTitle.textContent, '功能模組');
  assert.equal(h.sections[1].hidden, false);
  assert.equal(h.sections[0].hidden, true);
  h.root.click(h.target('#settingsCategoryBack'));
  assert.equal(h.elements.settingsCategoryHome.hidden, false);
  assert.equal(field.value, '未儲存的輸入');
  assert.equal(h.form.events.at(-1).type, 'settings:leave-category');
  assert.equal(h.form.events.at(-1).cancelable, true);
});

test('invalid pending module input can prevent category exit and app navigation', async () => {
  const h = await setup();
  h.root.click(h.target('[data-settings-category-open]', 'modules'));
  h.form.cancel = true;
  h.root.click(h.target('#settingsCategoryBack'));
  assert.equal(h.elements.settingsCategoryHome.hidden, true);
  assert.equal(h.sections[1].hidden, false);
  const event = h.root.click(h.target('[data-back]'));
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  h.form.cancel = false;
  h.root.click(h.target('#settingsCategoryBack'));
  assert.equal(h.elements.settingsCategoryHome.hidden, false);
});

test('returning to settings starts at the category home', async () => {
  const h = await setup();
  h.root.click(h.target('[data-settings-category-open]', 'accounts'));
  h.elements.settingsBtn.click({ closest: () => null });
  assert.equal(h.elements.settingsCategoryHome.hidden, false);
  assert.ok(h.sections.every(section => section.hidden));
});
