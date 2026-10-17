import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness() {
  class Element {
    listeners = new Map(); children = []; isConnected = true;
    classList = { contains: name => this.dragging && name === 'is-drag-placeholder' };
    addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
    emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event); }
    append(...items) { this.children.push(...items); }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() { this.removed = true; }
  }
  const body = new Element(), page = new Element(), document = new Element(), window = new Element();
  document.body = page; document.createElement = () => new Element();
  const row = new Element(); row.dataset = { edit: 'A' };
  const target = { closest: selector => selector === 'tr[data-edit]' ? row : null };
  let timerId = 0; const timers = new Map(), deletes = [];
  const context = vm.createContext({ document, window, Date, Math,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const code = fs.readFileSync(new URL('../js/orders-delete-hold.js', import.meta.url), 'utf8').replace('export function', 'function');
  vm.runInContext(code, context);
  context.bindOrderDeleteHold(body, id => ({ id, orderNumber: '26A12P0329' }), id => deletes.push(id));
  const pointer = { target, pointerId: 1, button: 0, isPrimary: true, clientX: 10, clientY: 10 };
  return { body, page, row, document, window, pointer, timers, deletes,
    press: () => body.emit('pointerdown', pointer),
    fire: () => { const task = [...timers.values()][0]; if (task) { timers.clear(); task.fn(); } },
  };
}

test('three-second hold opens actions, release does not open edit, deletion requires choosing delete', () => {
  const h = harness(); h.press();
  assert.equal([...h.timers.values()][0].delay, 3000);
  assert.equal(h.page.children.length, 0);
  h.fire(); const dialog = h.page.children[0];
  assert.equal(dialog.open, true); assert.equal(h.deletes.length, 0);
  h.document.emit('pointerup', h.pointer);
  let prevented = false, stopped = false;
  h.body.emit('click', { preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert(prevented && stopped);
  dialog.children[1].emit('click');
  assert.deepEqual(h.deletes, ['A']); assert.equal(dialog.removed, true);
});

test('release, scrolling, moving, cancellation and losing focus cancel a pending hold', () => {
  for (const cancel of [
    h => h.document.emit('pointerup', h.pointer),
    h => h.document.emit('pointercancel', h.pointer),
    h => h.document.emit('pointermove', { ...h.pointer, clientX: 30 }),
    h => h.document.emit('scroll'),
    h => h.window.emit('blur'),
    h => h.window.emit('resize'),
  ]) {
    const h = harness(); h.press(); cancel(h); h.fire();
    assert.equal(h.page.children.length, 0); assert.equal(h.deletes.length, 0);
  }
});

test('dragging and removed rows never open delete; cancelling the menu keeps the order', () => {
  for (const change of [h => { h.row.dragging = true; }, h => { h.row.isConnected = false; }]) {
    const h = harness(); h.press(); change(h); h.fire(); assert.equal(h.page.children.length, 0);
  }
  const h = harness(); h.press(); h.fire(); h.page.children[0].children[2].emit('click');
  assert.equal(h.deletes.length, 0);
});

test('confirmation cancellation preserves data; confirmation deletes only the selected order', () => {
  const source = fs.readFileSync(new URL('../js/orders.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function requestDeleteOrder(');
  const end = source.indexOf('\n  bindOrderDeleteHold(', start);
  let confirmed = false, saves = 0, renders = 0;
  const state = { orders: [{ id: 'A', orderNumber: 'A' }, { id: 'B', orderNumber: 'B' }] };
  const context = { state, cancelRowClick() {}, window: { confirm: () => confirmed }, saveState: () => saves++, renderAll: () => renders++ };
  vm.runInNewContext(source.slice(start, end), context);
  context.requestDeleteOrder('A'); assert.equal(state.orders.length, 2); assert.equal(saves, 0);
  confirmed = true; context.requestDeleteOrder('A');
  assert.deepEqual(state.orders.map(o => o.id), ['B']); assert.equal(saves, 1); assert.equal(renders, 1);
});

test('mobile hold survives pointer cancellation and small finger drift', () => {
  const h = harness();
  const point = { identifier: 7, clientX: 10, clientY: 10 };
  const touch = { target: h.pointer.target, touches: [point] };
  h.body.emit('pointerdown', { ...h.pointer, pointerType: 'touch' });
  assert.equal(h.timers.size, 0);
  h.body.emit('touchstart', touch);
  h.document.emit('pointercancel', { ...h.pointer, pointerType: 'touch' });
  h.document.emit('touchmove', { touches: [{ ...point, clientX: 20 }] });
  assert.equal(h.timers.size, 1);
  h.fire(); assert.equal(h.page.children[0].open, true);
  let prevented = false;
  h.document.emit('touchend', { cancelable: true, preventDefault: () => { prevented = true; } });
  assert(prevented); assert.equal(h.deletes.length, 0);
});

test('mobile scrolling, release, cancellation and multitouch cancel pending holds', () => {
  for (const cancel of [
    h => h.document.emit('touchmove', { touches: [{ clientX: 60, clientY: 10 }] }),
    h => h.document.emit('touchend', {}),
    h => h.document.emit('touchcancel', {}),
    h => h.body.emit('touchstart', { touches: [{}, {}] }),
    h => h.document.emit('scroll'),
  ]) {
    const h = harness();
    h.body.emit('touchstart', { target: h.pointer.target, touches: [{ identifier: 7, clientX: 10, clientY: 10 }] });
    cancel(h); h.fire(); assert.equal(h.page.children.length, 0);
  }
});

test('More opens the same menu without a hold and does not delete until selected', () => {
  const h = harness();
  let stopped = false;
  h.body.emit('click', {
    target: { closest: () => ({ dataset: { orderMenu: 'A' } }) },
    preventDefault() {}, stopImmediatePropagation() { stopped = true; },
  });
  assert(stopped); assert.equal(h.page.children[0].open, true); assert.equal(h.deletes.length, 0);
  h.page.children[0].children[2].emit('click'); assert.equal(h.deletes.length, 0);
});
