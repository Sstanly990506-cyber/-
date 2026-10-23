import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness() {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  class Node {
    listeners = new Map(); isConnected = true;
    classes = new Set();
    classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
    addEventListener(name, fn, options) {
      const handlers = this.listeners.get(name) || [];
      handlers.push({ fn, capture: options === true }); this.listeners.set(name, handlers);
    }
    emit(name, event = {}) {
      event.preventDefault ||= () => { event.defaultPrevented = true; };
      event.stopImmediatePropagation ||= () => { event.stopped = true; };
      for (const {fn} of [...this.listeners.get(name) || []].sort((a,b) => b.capture - a.capture)) {
        fn(event); if (event.stopped) break;
      }
    }
    children = [];
    append(...items) { this.children.push(...items); }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() {}
  }
  const body = new Node(), document = new Node(), window = new Node();
  document.body = new Node(); document.createElement = () => new Node();
  const rows = ['A','B','C'].map(id => Object.assign(new Node(), { dataset: { edit: id } }));
  const state = { orders: rows.map(row => ({ id: row.dataset.edit, orderNumber: row.dataset.edit, sortOrder: rows.indexOf(row) })) };
  const edited = [], copied = [], saved = [];
  let preview;
  const context = vm.createContext({
    document, window, state, Math, Date: { now: () => now },
    $: id => id === 'ordersTbody' ? body : null,
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    saveState: () => saved.push(state.orders.map(o => ({ ...o }))), renderAll() {},
    moveOrder: (id,targetId,after) => {
      const ordered=[...state.orders].sort((a,b)=>a.sortOrder-b.sortOrder).filter(row=>row.id!==id);
      const moved=state.orders.find(row=>row.id===id);
      ordered.splice(ordered.findIndex(row=>row.id===targetId)+Number(after),0,moved);
      ordered.forEach((row,position)=>{row.sortOrder=position;});
      saved.push(state.orders.map(o=>({...o})));
      return Promise.resolve();
    },
    sortedOrders: state => [...state.orders].sort((a,b) => a.sortOrder - b.sortOrder),
    openOrderForEdit: (_,id) => edited.push(id), copyOrderAsNew: (_,id) => copied.push(id),
    createOrderDragPreview: (_,row,point,onReorder) => {
      row.classList.add('is-drag-placeholder');
      preview = {
        move(point) { if (point.clientY >= 100) onReorder('C', true); }, flush() {},
        drop(done) { row.classList.remove('is-drag-placeholder'); done(); },
        cancel(done) { row.classList.remove('is-drag-placeholder'); done(); },
      };
      return preview;
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../js/orders-delete-hold.js', import.meta.url),'utf8').replace('export function','function'), context);
  const source = fs.readFileSync(new URL('../js/orders.js', import.meta.url), 'utf8');
  const start = source.indexOf('  let pendingRowClick = null;');
  const end = source.indexOf("  $('clearOrderBtn')", start);
  vm.runInContext(source.slice(start,end),context);
  const target = (row,handle=false) => ({ closest: selector => selector === 'tr[data-edit]' ? row : handle && ['button[data-drag-order]','button, input, select, textarea, a','button'].includes(selector) ? {dataset:{dragOrder:row.dataset.edit}} : null });
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = end;
  }
  return { rows, state, edited, copied, saved, document, advance,
    down: (i=0,handle=false) => body.emit('touchstart', { target: target(rows[i],handle), touches: [{identifier:1,clientX:10,clientY:10}], cancelable: true }),
    up: () => document.emit('touchend', { touches: [], cancelable: true }),
    move: y => document.emit('touchmove', { touches: [{identifier:1,clientX:10,clientY:y}], cancelable: true }),
    cancel: () => document.emit('touchcancel', {}),
    click: (i=0) => body.emit('click', { target: target(rows[i]) }),
    mouseDown: () => body.emit('pointerdown', { target: target(rows[0]), pointerType:'mouse',pointerId:9,button:0 }),
    mouseMove: y => document.emit('pointermove', {pointerType:'mouse',pointerId:9,clientX:10,clientY:y}),
    mouseUp: () => document.emit('pointerup', {pointerType:'mouse',pointerId:9}),
  };
}

test('Safari double-tap hold reorders without any synthesized click and saves new order', () => {
  const h = harness(); h.down(); h.advance(40); h.up();
  assert(h.rows[0].classList.contains('is-tap-armed'));
  h.advance(100); h.down(); h.advance(310); h.move(120); h.up(); h.advance(4000);
  assert.deepEqual(h.state.orders.map(o => o.sortOrder), [2,0,1]);
  assert.equal(h.saved.length,1); assert.equal(h.edited.length,0); assert.equal(h.copied.length,0);
  assert.equal(h.document.body.children.length,0);
});

test('synthetic touch clicks do not copy or edit after drag', () => {
  const h=harness(); h.down();h.up();h.click();h.advance(80);h.down();h.advance(310);h.move(120);h.up();h.click();h.advance(1000);
  assert.equal(h.saved.length,1);assert.equal(h.edited.length,0);assert.equal(h.copied.length,0);
});

test('quick double tap still copies exactly once', () => {
  const h=harness();h.down();h.up();h.click();h.advance(80);h.down();h.advance(50);h.up();h.click();h.advance(4000);
  assert.deepEqual(h.copied,['A']);assert.equal(h.saved.length,0);assert.equal(h.edited.length,0);
});

test('single touch opens edit; scrolling and cancellation never reorder', () => {
  const h=harness();h.down();h.up();h.advance(501);assert.deepEqual(h.edited,['A']);
  const scroll=harness();scroll.down();scroll.move(100);scroll.up();scroll.advance(4000);
  assert.equal(scroll.edited.length,0);assert.equal(scroll.saved.length,0);
  const cancel=harness();cancel.down();cancel.up();cancel.advance(60);cancel.down();cancel.advance(310);cancel.move(120);cancel.cancel();cancel.advance(4000);
  assert.equal(cancel.saved.length,0);assert.equal(cancel.edited.length,0);
});

test('stationary three-second hold opens delete menu without edit or sorting', () => {
  const h=harness();h.down();h.advance(3001);h.up();h.advance(1000);
  assert.equal(h.document.body.children.length,1);assert.equal(h.edited.length,0);assert.equal(h.saved.length,0);
});

test('mouse double-click hold still reorders', () => {
  const h=harness();h.click();h.advance(60);h.mouseDown();h.advance(310);h.mouseMove(120);h.mouseUp();h.advance(4000);
  assert.equal(h.saved.length,1);assert.equal(h.edited.length,0);assert.equal(h.copied.length,0);
});


test('explicit Move handle works on the first hold and a short tap never copies',()=>{
  const h=harness();h.down(0,true);h.advance(310);h.move(120);h.up();h.advance(1000);
  assert.equal(h.saved.length,1);assert.equal(h.copied.length,0);
  const tap=harness();tap.down(0,true);tap.advance(40);tap.up();tap.advance(1000);
  assert.equal(tap.saved.length,0);assert.equal(tap.copied.length,0);assert.equal(tap.edited.length,0);
});
