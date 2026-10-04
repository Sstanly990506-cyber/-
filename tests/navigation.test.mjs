import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');

test('navigation routes finance through its gate and ignores empty targets', () => {
  const calls = [];
  const start = source.indexOf('function openDashboardTarget(');
  const end = source.indexOf('\n}', start) + 2;
  const context = { showView: id => calls.push(id), openFinanceGate: () => calls.push('gate') };
  vm.runInNewContext(source.slice(start, end), context);
  context.openDashboardTarget('ordersView');
  context.openDashboardTarget('financeView');
  context.openDashboardTarget('');
  assert.deepEqual(calls, ['ordersView', 'gate']);
});

test('shortcut ignores malformed keys, text entry and browser shortcuts', () => {
  const start = source.indexOf("window.addEventListener('keydown', (e) => {");
  const end = source.indexOf('\n  });', start) + 6;
  let handler;
  let opened = 0;
  class Element { closest() { return true; } }
  vm.runInNewContext(source.slice(start, end), {
    window: { addEventListener: (_, fn) => { handler = fn; } },
    state: { settings: { enableKeyboardShortcut: true } }, Element,
    $: () => ({ classList: { contains: () => false } }), showView: () => { opened++; },
  });
  for (const event of [{}, { key: 'a', ctrlKey: true }, { key: 'a', defaultPrevented: true }, { key: 'a', target: new Element() }]) handler(event);
  assert.equal(opened, 0);
  handler({ key: 'A' });
  assert.equal(opened, 1);
});
