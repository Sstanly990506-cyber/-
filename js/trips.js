import { $, money } from './shared.js';
import { DEFAULT_FACTORY } from './trips/constants.js';
import { inferLatLngFromAddress, optimizeTrip, evaluateRoute, validateBusinessRoute } from './trips/core.js';
import { formatDuration, renderCustomerOptions, renderResult, renderManualRoute } from './trips/ui.js';

let manualStops = [];
let selectedOrderIds = new Set();
let manualRoute = [];
let lastResult = null;

function getCompletedOrders(state) {
  return state.orders.filter((o) => o.status === '已完成');
}

function selectedOrderStops(state) {
  return getCompletedOrders(state)
    .filter((o) => selectedOrderIds.has(o.id))
    .map((o) => ({
      id: o.id,
      name: o.downstream || o.upstream || o.orderNumber || '未命名站點',
      address: o.address || '-',
      lat: DEFAULT_FACTORY.lat + ((o.id || '').length % 7) / 1000,
      lng: DEFAULT_FACTORY.lng + ((o.orderNumber || '').length % 11) / 1000,
      type: 'delivery',
      relatedOrderId: o.orderNumber || '',
      note: 'from-completed-order',
    }));
}

function allStops(state) {
  return [...selectedOrderStops(state), ...manualStops];
}

function renderOrdersPool(state) {
  const body = $('tripOrdersTbody');
  if (!body) return;
  body.innerHTML = '';
  getCompletedOrders(state).forEach((order) => {
    const checked = selectedOrderIds.has(order.id) ? 'checked' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-trip-order-check="${order.id}" ${checked} /></td>
      <td>${order.orderNumber || '-'}</td>
      <td>${order.downstream || order.upstream || '-'}</td>
      <td>${order.address || '-'}</td>
      <td>送貨</td>
      <td>${order.orderNumber || '-'}</td>`;
    body.append(tr);
  });
}

function renderSelectedStops(state) {
  const body = $('tripStopsTbody');
  if (!body) return;
  body.innerHTML = '';
  const stops = allStops(state);
  stops.forEach((s, idx) => {
    const canDelete = s.note === 'from-completed-order' ? '' : `<button class="btn" data-del-stop="${s.id}">刪除</button>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx + 1}</td><td>${s.name}</td><td>${s.type}</td><td>${s.relatedOrderId || '-'}</td><td>${s.address || '-'}</td><td>${canDelete}</td>`;
    body.append(tr);
  });
  $('tripStopsCount').textContent = String(stops.length);
  $('tripStopsTypeSummary').textContent = `delivery ${stops.filter((s) => s.type === 'delivery').length} / pickup ${stops.filter((s) => s.type === 'pickup').length}`;
}

function updateManualHint() {
  if (!manualRoute.length) {
    $('tripManualHint').textContent = '手動調整後會顯示預估時間';
    return;
  }
  const score = evaluateRoute(manualRoute);
  $('tripManualHint').textContent = `手動路線預估：${formatDuration(score.totalDurationSec)} / ${money(score.totalDistanceM)} m`;
}

function renderAll(state) {
  renderCustomerOptions(state.customers);
  renderOrdersPool(state);
  renderSelectedStops(state);
  renderResult(lastResult);
  renderManualRoute(manualRoute);
  updateManualHint();
}

function createManualStop(state) {
  const name = $('tripCustomerName').value.trim();
  const customer = state.customers.find((c) => (c.name || '').trim() === name && c.active !== false);
  if (!customer) return alert('請從客戶系統已有資料選擇客戶'), null;
  const address = customer.address || '';
  const pos = inferLatLngFromAddress(address || customer.name);
  return {
    id: crypto.randomUUID(),
    name: customer.name,
    address,
    lat: pos.lat,
    lng: pos.lng,
    type: $('tripStopType').value,
    relatedOrderId: $('tripRelatedOrderId').value.trim(),
    note: 'manual-trip-stop',
  };
}

async function runOptimize(state) {
  const stops = allStops(state);
  if (!stops.length) return alert('請先勾選完成工單或新增站點');
  const payload = { factory: DEFAULT_FACTORY, stops };
  try {
    const res = await fetch('/api/trips/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    lastResult = await res.json();
  } catch {
    lastResult = optimizeTrip(DEFAULT_FACTORY, stops);
  }
  manualRoute = (lastResult.bestRoute.orderedStops || []).map((r) => ({ ...r }));
}

function executeSelectedOrders(state, saveState, renderAllApp) {
  const completed = getCompletedOrders(state).filter((o) => selectedOrderIds.has(o.id));
  if (!completed.length) return alert('請先勾選要執行的完成工單');
  completed.forEach((o) => {
    o.status = '已送出';
    o.updatedAt = new Date().toLocaleString();
  });
  saveState();
  renderAllApp();
  selectedOrderIds = new Set();
  lastResult = null;
  manualRoute = [];
}

export function renderTrips(state) {
  renderAll(state);
}

export function bindTripEvents(state, saveState, renderAllApp) {
  $('tripCustomerName')?.addEventListener('input', () => {
    const c = state.customers.find((x) => (x.name || '').trim() === $('tripCustomerName').value.trim());
    $('tripCustomerAddress').value = c?.address || '';
  });

  $('tripAddStopForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const stop = createManualStop(state);
    if (!stop) return;
    manualStops.push(stop);
    e.target.reset();
    $('tripCustomerAddress').value = '';
    renderAll(state);
  });

  $('tripOrdersTbody')?.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-trip-order-check]');
    if (!cb) return;
    if (cb.checked) selectedOrderIds.add(cb.dataset.tripOrderCheck);
    else selectedOrderIds.delete(cb.dataset.tripOrderCheck);
    renderSelectedStops(state);
  });

  $('tripStopsTbody')?.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del-stop]');
    if (!del) return;
    manualStops = manualStops.filter((s) => s.id !== del.dataset.delStop);
    renderAll(state);
  });

  $('tripOptimizeBtn')?.addEventListener('click', async () => {
    await runOptimize(state);
    renderAll(state);
  });

  $('tripClearBtn')?.addEventListener('click', () => {
    manualStops = [];
    selectedOrderIds = new Set();
    manualRoute = [];
    lastResult = null;
    renderAll(state);
  });

  $('tripExecuteBtn')?.addEventListener('click', () => {
    executeSelectedOrders(state, saveState, renderAllApp);
    renderAll(state);
  });

  $('tripManualRoute')?.addEventListener('click', (e) => {
    const up = e.target.closest('button[data-route-up]');
    const down = e.target.closest('button[data-route-down]');
    if (!up && !down) return;
    const idx = Number((up || down).dataset.routeUp || (up || down).dataset.routeDown);
    const target = up ? idx - 1 : idx + 1;
    if (target <= 0 || target >= manualRoute.length - 1) return;
    [manualRoute[idx], manualRoute[target]] = [manualRoute[target], manualRoute[idx]];
    if (!validateBusinessRoute(manualRoute)) {
      [manualRoute[idx], manualRoute[target]] = [manualRoute[target], manualRoute[idx]];
      return alert('不合法：pickup 不能排在 delivery 前面');
    }
    updateManualHint();
    renderManualRoute(manualRoute);
  });
}
