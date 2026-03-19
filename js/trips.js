import { $, money } from './shared.js';
import { DEFAULT_FACTORY } from './trips/constants.js';
import { inferLatLngFromAddress, optimizeTrip, evaluateRoute, validateBusinessRoute, buildGoogleMapsUrl } from './trips/core.js';
import { formatDuration, renderCustomerOptions, renderResult, renderManualRoute } from './trips/ui.js';

let manualStops = [];
let selectedOrderIds = new Set();
let orderStopTypes = {};
let manualRoute = [];
let lastResult = null;
let manualRouteConfirmed = false;

function getTripModuleSettings(state) {
  return state.settings?.moduleInternals?.trips || { stopTypes: { delivery: true, pickup: true }, showManualRoute: true, showManualStopForm: true, showOrderPool: true };
}

function getEnabledTripTypes(state) {
  const types = getTripModuleSettings(state).stopTypes || { delivery: true, pickup: true };
  const items = ['delivery', 'pickup'].filter((type) => types[type] !== false);
  return items.length ? items : ['delivery'];
}

function renderTripTypeOptions(state) {
  const select = $('tripStopType');
  if (!select) return;
  const current = select.value;
  const types = getEnabledTripTypes(state);
  select.innerHTML = types.map((type) => `<option value="${type}">${typeLabel(type)}</option>`).join('');
  select.value = types.includes(current) ? current : types[0];
}

function findCustomer(state, keyword) {
  const key = (keyword || '').trim().toLowerCase();
  if (!key) return null;
  return state.customers.find((c) => (c.name || '').trim().toLowerCase() === key)
    || state.customers.find((c) => (c.name || '').toLowerCase().includes(key));
}

function getTripOrders(state) {
  return state.orders;
}

function getOrderStopType(orderId, state) {
  return orderStopTypes[orderId] || getEnabledTripTypes(state)[0];
}

function typeLabel(type) {
  return type === 'pickup' ? '載貨' : '送貨';
}

function selectedOrderStops(state) {
  return getTripOrders(state)
    .filter((o) => selectedOrderIds.has(o.id))
    .map((o) => ({
      id: o.id,
      name: o.downstream || o.upstream || o.orderNumber || '未命名站點',
      address: o.address || '-',
      ...inferLatLngFromAddress(o.address || o.downstream || o.upstream || o.orderNumber || ''),
      type: getOrderStopType(o.id, state),
      relatedOrderId: o.orderNumber || '',
      note: 'from-order-pool',
    }));
}

function allStops(state) {
  return [...selectedOrderStops(state), ...manualStops];
}

function renderOrdersPool(state) {
  const body = $('tripOrdersTbody');
  if (!body) return;
  body.innerHTML = '';
  const types = getEnabledTripTypes(state);
  const orders = getTripOrders(state);
  selectedOrderIds.forEach((id) => {
    if (!orders.some((o) => o.id === id)) selectedOrderIds.delete(id);
  });
  Object.keys(orderStopTypes).forEach((id) => {
    if (!orders.some((o) => o.id === id)) delete orderStopTypes[id];
  });
  orders.forEach((order) => {
    const checked = selectedOrderIds.has(order.id) ? 'checked' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-trip-order-check="${order.id}" ${checked} /></td>
      <td>${order.orderNumber || '-'}</td>
      <td>${order.downstream || order.upstream || '-'}</td>
      <td>${order.address || '-'}</td>
      <td>
        <select data-trip-order-type="${order.id}">
          ${types.map((type) => `<option value="${type}" ${getOrderStopType(order.id, state) === type ? 'selected' : ''}>${typeLabel(type)}</option>`).join('')}
        </select>
      </td>
      <td>${order.status || '未完成'}</td>`;
    body.append(tr);
  });
}

function renderSelectedStops(state) {
  const body = $('tripStopsTbody');
  if (!body) return;
  body.innerHTML = '';
  const stops = allStops(state);
  stops.forEach((s, idx) => {
    const canDelete = s.note === 'from-order-pool' ? '' : `<button class="btn" data-del-stop="${s.id}">刪除</button>`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx + 1}</td><td>${s.name}</td><td>${typeLabel(s.type)}</td><td>${s.relatedOrderId || '-'}</td><td>${s.address || '-'}</td><td>${canDelete}</td>`;
    body.append(tr);
  });
  $('tripStopsCount').textContent = String(stops.length);
  $('tripStopsTypeSummary').textContent = `送貨 ${stops.filter((s) => s.type === 'delivery').length} / 載貨 ${stops.filter((s) => s.type === 'pickup').length}`;
}

function updateManualHint() {
  if (!manualRoute.length) {
    $('tripManualHint').textContent = '手動調整後會顯示預估時間';
    return;
  }
  const score = evaluateRoute(manualRoute);
  const confirmNote = manualRouteConfirmed ? '（已確認）' : '（尚未確認）';
  $('tripManualHint').textContent = `手動路線預估：${formatDuration(score.totalDurationSec)} / ${money(score.totalDistanceM)} m ${confirmNote}`;
}

function renderAll(state) {
  renderCustomerOptions(state.customers);
  renderTripTypeOptions(state);
  const settings = getTripModuleSettings(state);
  const hideManualStopForm = settings.showManualStopForm === false;
  const hideOrderPool = settings.showOrderPool === false;
  const hideManualRoute = settings.showManualRoute === false;

  $('tripManualStopCard')?.classList.toggle('hidden', hideManualStopForm);
  $('tripOrderPoolCard')?.classList.toggle('hidden', hideOrderPool);
  $('tripRouteCard')?.classList.toggle('hidden', hideManualRoute);

  if (hideOrderPool) {
    selectedOrderIds = new Set();
    orderStopTypes = {};
  }
  if (hideManualRoute) {
    manualRoute = [];
    lastResult = null;
    manualRouteConfirmed = false;
  }
  renderOrdersPool(state);
  renderSelectedStops(state);
  renderResult(lastResult);
  renderManualRoute(manualRoute, manualRouteConfirmed);
  updateManualHint();
}

function createManualStop(state) {
  const name = $('tripCustomerName').value.trim();
  const customer = findCustomer(state, name);
  if (customer && customer.active === false) return alert('此客戶已停用'), null;
  if (!customer) return alert('請從客戶系統已有資料選擇客戶'), null;

  const relatedOrderId = $('tripRelatedOrderId').value.trim();
  if (!relatedOrderId) return alert('請填寫工號'), null;
  if (allStops(state).some((s) => (s.relatedOrderId || '').trim() === relatedOrderId)) {
    return alert('此工號已存在於車趟站點，請勿重複新增'), null;
  }

  const address = customer.address || '';
  const pos = inferLatLngFromAddress(address || customer.name);
  return {
    id: crypto.randomUUID(),
    name: customer.name,
    address,
    lat: pos.lat,
    lng: pos.lng,
    type: $('tripStopType').value || getEnabledTripTypes(state)[0],
    relatedOrderId,
    note: 'manual-trip-stop',
  };
}

async function runOptimize(state) {
  const stops = allStops(state);
  if (!stops.length) return alert('請先勾選工單或新增站點');
  const payload = { factory: DEFAULT_FACTORY, stops };
  try {
    const res = await fetch('/api/trips/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error();
    lastResult = await res.json();
  } catch {
    lastResult = optimizeTrip(DEFAULT_FACTORY, stops);
  }
  manualRoute = (lastResult.bestRoute.orderedStops || []).map((r) => ({ ...r }));
  manualRouteConfirmed = false;
}

function confirmManualRoute() {
  if (!manualRoute.length) return alert('請先點「最佳化車輛」產生路線');
  if (!validateBusinessRoute(manualRoute)) return alert('目前路線不合法：pickup 不能排在 delivery 前面');

  const score = evaluateRoute(manualRoute);
  if (lastResult) {
    lastResult.bestRoute.orderedStops = manualRoute.map((s) => ({ ...s }));
    lastResult.bestRoute.pointIds = manualRoute.map((s) => s.id);
    lastResult.bestRoute.totalDurationSec = score.totalDurationSec;
    lastResult.bestRoute.totalDistanceM = score.totalDistanceM;
    lastResult.googleMapsUrl = buildGoogleMapsUrl(manualRoute);
  }
  manualRouteConfirmed = true;
  alert(`已確認手動路線（預估 ${formatDuration(score.totalDurationSec)}）`);
}

function executeSelectedOrders(state, saveState, renderAllApp) {
  const selectedOrders = getTripOrders(state).filter((o) => selectedOrderIds.has(o.id));
  if (!selectedOrders.length) return alert('請先勾選要執行的工單');
  if (manualRoute.length && !manualRouteConfirmed) return alert('你有手動調整路線，請先按「確認手動路線」');

  selectedOrderIds = new Set();
  orderStopTypes = {};
  lastResult = null;
  manualRoute = [];
  manualRouteConfirmed = false;
  saveState();
  renderAllApp();
}

export function renderTrips(state) {
  renderAll(state);
}

export function bindTripEvents(state, saveState, renderAllApp) {
  const fillAddress = () => {
    const c = findCustomer(state, $('tripCustomerName').value);
    $('tripCustomerAddress').value = c?.address || '';
    if (c) $('tripCustomerName').value = c.name;
  };

  $('tripCustomerName')?.addEventListener('input', fillAddress);
  $('tripCustomerName')?.addEventListener('change', fillAddress);
  $('tripCustomerName')?.addEventListener('blur', fillAddress);

  $('tripAddStopForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const stop = createManualStop(state);
    if (!stop) return;
    manualStops.push(stop);
    manualRouteConfirmed = false;
    e.target.reset();
    $('tripCustomerAddress').value = '';
    renderAll(state);
  });

  $('tripOrdersTbody')?.addEventListener('change', (e) => {
    const typeSelect = e.target.closest('select[data-trip-order-type]');
    if (typeSelect) {
      orderStopTypes[typeSelect.dataset.tripOrderType] = typeSelect.value;
      manualRouteConfirmed = false;
      renderSelectedStops(state);
      updateManualHint();
      return;
    }

    const cb = e.target.closest('input[data-trip-order-check]');
    if (!cb) return;
    if (cb.checked) selectedOrderIds.add(cb.dataset.tripOrderCheck);
    else selectedOrderIds.delete(cb.dataset.tripOrderCheck);
    manualRouteConfirmed = false;
    renderSelectedStops(state);
    updateManualHint();
  });

  $('tripStopsTbody')?.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del-stop]');
    if (!del) return;
    manualStops = manualStops.filter((s) => s.id !== del.dataset.delStop);
    manualRouteConfirmed = false;
    renderAll(state);
  });

  $('tripOptimizeBtn')?.addEventListener('click', async () => {
    await runOptimize(state);
    renderAll(state);
  });

  $('tripConfirmManualBtn')?.addEventListener('click', () => {
    confirmManualRoute();
    renderAll(state);
  });

  $('tripClearBtn')?.addEventListener('click', () => {
    manualStops = [];
    selectedOrderIds = new Set();
    orderStopTypes = {};
    manualRoute = [];
    lastResult = null;
    manualRouteConfirmed = false;
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
    manualRouteConfirmed = false;
    updateManualHint();
    renderManualRoute(manualRoute, manualRouteConfirmed);
  });
}
