import { $, money } from './shared.js';
import { DEFAULT_FACTORY } from './trips/constants.js';
import { inferLatLngFromAddress, optimizeTrip, evaluateRoute, validateBusinessRoute } from './trips/core.js';
import { formatDuration, renderCustomerOptions, renderStops, renderResult, renderManualRoute } from './trips/ui.js';

let tripStops = [];
let manualRoute = [];
let lastResult = null;

function resolveFactory() {
  return {
    id: DEFAULT_FACTORY.id,
    name: $('tripFactoryName').value.trim() || DEFAULT_FACTORY.name,
    address: $('tripFactoryAddress').value.trim() || DEFAULT_FACTORY.address,
    lat: DEFAULT_FACTORY.lat,
    lng: DEFAULT_FACTORY.lng,
  };
}

function fillAddressFromCustomer(state) {
  const name = $('tripStopName').value.trim();
  const customer = state.customers.find((c) => (c.name || '').trim() === name);
  $('tripStopAddress').value = customer?.address || '';
}

function createStopFromForm(state) {
  const name = $('tripStopName').value.trim();
  const customer = state.customers.find((c) => (c.name || '').trim() === name);
  if (!customer) {
    alert('請先從客戶系統建立客戶，並由下拉選單選擇站點名稱');
    return null;
  }
  const address = customer.address || '';
  const guessed = inferLatLngFromAddress(address || name);
  return {
    id: crypto.randomUUID(),
    name: customer.name,
    address,
    lat: guessed.lat,
    lng: guessed.lng,
    type: $('tripStopType').value,
    relatedOrderId: $('tripRelatedOrderId').value.trim(),
    note: $('tripStopNote').value.trim(),
  };
}

function updateManualHint() {
  if (!manualRoute.length) {
    $('tripManualHint').textContent = '手動調整後會顯示預估時間';
    return;
  }
  const score = evaluateRoute(manualRoute);
  $('tripManualHint').textContent = `手動路線預估：${formatDuration(score.totalDurationSec)} / ${money(score.totalDistanceM)} m`;
}

async function runOptimize(state) {
  const payload = { factory: resolveFactory(), stops: tripStops };
  if (!tripStops.length) return alert('請先新增至少 1 個站點');

  try {
    const res = await fetch('/api/trips/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('api failed');
    const result = await res.json();
    result.bestRoute.orderedStops = result.bestRoute.orderedStops || result.bestRoute.pointIds.map((id) => [payload.factory, ...tripStops].find((p) => p.id === id)).filter(Boolean);
    lastResult = result;
  } catch {
    lastResult = optimizeTrip(payload.factory, tripStops);
  }

  manualRoute = lastResult.bestRoute.orderedStops.map((r) => ({ ...r }));
  renderResult(lastResult);
  renderManualRoute(manualRoute);
  updateManualHint();
}

export function renderTrips(state) {
  renderCustomerOptions(state.customers);
  renderStops(tripStops);
  renderResult(lastResult);
  renderManualRoute(manualRoute);
  updateManualHint();
}

export function bindTripEvents(state) {
  $('tripFactoryName').value = $('tripFactoryName').value || DEFAULT_FACTORY.name;
  $('tripFactoryAddress').value = $('tripFactoryAddress').value || DEFAULT_FACTORY.address;

  $('tripStopName')?.addEventListener('input', () => fillAddressFromCustomer(state));

  $('tripAddStopForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const stop = createStopFromForm(state);
    if (!stop) return;
    tripStops.push(stop);
    e.target.reset();
    $('tripStopAddress').value = '';
    renderTrips(state);
  });

  $('tripStopsTbody')?.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del-stop]');
    if (!del) return;
    tripStops = tripStops.filter((s) => s.id !== del.dataset.delStop);
    renderTrips(state);
  });

  $('tripOptimizeBtn')?.addEventListener('click', () => runOptimize(state));

  $('tripClearBtn')?.addEventListener('click', () => {
    tripStops = [];
    manualRoute = [];
    lastResult = null;
    renderTrips(state);
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

    renderManualRoute(manualRoute);
    updateManualHint();
  });
}
