import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/theme.js', import.meta.url), 'utf8');

async function setup({ saved, dark = false, blocked = false } = {}) {
  class Element {
    children = []; listeners = {}; value = ''; textContent = ''; dataset = {}; style = {};
    append(...children) { this.children.push(...children); }
    prepend(child) { this.children.unshift(child); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
    emit(name) { this.listeners[name]?.(); }
  }
  const shell = new Element(), html = new Element(), windowEvents = {}, media = { matches: dark };
  media.addEventListener = (_, fn) => { media.change = fn; };
  let stored = saved ?? null;
  const storage = {
    getItem() { if (blocked) throw Error('blocked'); return stored; },
    setItem(_, value) { if (blocked) throw Error('blocked'); stored = value; },
  };
  const document = { documentElement: html, querySelector: () => shell, createElement: () => new Element() };
  const window = { matchMedia: () => media, addEventListener: (name, fn) => { windowEvents[name] = fn; } };
  const mod = new vm.SourceTextModule(source, { context: vm.createContext({ document, window, localStorage: storage }) });
  await mod.link(() => { throw Error('unexpected import'); }); await mod.evaluate();
  mod.namespace.initializeTheme();
  const select = shell.children[0].children[0].children[1];
  return { html, media, select, windowEvents, stored: () => stored, initialize: mod.namespace.initializeTheme, shell };
}

test('first visit follows the device and reacts when the device appearance changes', async () => {
  const h = await setup({ dark: true });
  assert.equal(h.html.dataset.colorMode, 'dark');
  assert.equal(h.select.value, 'system');
  h.media.matches = false; h.media.change();
  assert.equal(h.html.dataset.colorMode, 'light');
  h.initialize(); assert.equal(h.shell.children.length, 1);
});

test('manual mode persists and remains stable when device mode changes', async () => {
  const h = await setup({ dark: true });
  h.select.value = 'light'; h.select.emit('change');
  assert.equal(h.stored(), 'light');
  h.media.matches = false; h.media.change();
  h.media.matches = true; h.media.change();
  assert.equal(h.html.dataset.colorMode, 'light');
  const next = await setup({ saved: h.stored(), dark: true });
  assert.equal(next.html.dataset.colorMode, 'light');
});

test('following device can be restored and tabs synchronize without saving credentials', async () => {
  const h = await setup({ saved: 'dark', dark: false });
  h.select.value = 'system'; h.select.emit('change');
  assert.equal(h.stored(), 'system'); assert.equal(h.html.dataset.colorMode, 'light');
  h.windowEvents.storage({ key: 'sanqingAppearance', newValue: 'dark' });
  assert.equal(h.html.dataset.colorMode, 'dark');
  h.windowEvents.storage({ key: 'sanqingAppearance', newValue: 'invalid' });
  assert.equal(h.select.value, 'system'); assert.equal(h.html.dataset.colorMode, 'light');
});

test('unavailable local storage does not prevent selecting an appearance', async () => {
  const h = await setup({ blocked: true });
  h.select.value = 'dark'; h.select.emit('change');
  assert.equal(h.html.dataset.colorMode, 'dark');
});
