import { $, money } from './shared.js';

/** @typedef {'delivery'|'pickup'} StopType */
/**
 * @typedef {Object} TripStop
 * @property {string} id
 * @property {string} name
 * @property {string} address
 * @property {number} lat
 * @property {number} lng
 * @property {StopType} type
 * @property {string} relatedOrderId
 * @property {string=} note
 */

let tripStops = [];
let lastOptimizeResult = null;
let manualRoute = [];

function toPointLabel(point) {
  if (!point) return '-';
  return point.name || point.id || '-';
}

function permute(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((item, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    permute(rest).forEach((tail) => out.push([item, ...tail]));
  });
  return out;
}

function normalizeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inferDurationAndDistance(a, b) {
  const dx = (normalizeNum(a.lat) - normalizeNum(b.lat)) * 111000;
  const dy = (normalizeNum(a.lng) - normalizeNum(b.lng)) * 101000;
  const meters = Math.round(Math.sqrt(dx * dx + dy * dy));
  const durationSec = Math.max(60, Math.round((meters / 1000) * 180));
  return { durationSec, distanceM: meters };
}

function keyOf(a, b) {
  return `${a.id}->${b.id}`;
}

function buildMatrixMap(points, matrix) {
  const map = new Map();
  if (matrix?.pointIds?.length && Array.isArray(matrix?.durationsSec)) {
    const pointIdToIdx = new Map(matrix.pointIds.map((id, idx) => [id, idx]));
    points.forEach((a) => {
      points.forEach((b) => {
        const i = pointIdToIdx.get(a.id);
        const j = pointIdToIdx.get(b.id);
        if (i == null || j == null) return;
        const durationSec = normalizeNum(matrix.durationsSec?.[i]?.[j]);
        const distanceM = normalizeNum(matrix.distancesM?.[i]?.[j]);
        map.set(keyOf(a, b), { durationSec, distanceM });
      });
    });
    return map;
  }

  points.forEach((a) => {
    points.forEach((b) => {
      map.set(keyOf(a, b), inferDurationAndDistance(a, b));
    });
  });
  return map;
}

function evaluateRoute(route, matrixMap) {
  let durationSec = 0;
  let distanceM = 0;
  for (let i = 0; i < route.length - 1; i += 1) {
    const seg = matrixMap.get(keyOf(route[i], route[i + 1]));
    if (!seg) continue;
    durationSec += normalizeNum(seg.durationSec);
    distanceM += normalizeNum(seg.distanceM);
  }
  return { durationSec, distanceM };
}

function buildGoogleMapsUrl(route) {
  const origin = `${route[0].lat},${route[0].lng}`;
  const destination = `${route[route.length - 1].lat},${route[route.length - 1].lng}`;
  const waypoints = route.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving&waypoints=${encodeURIComponent(waypoints)}`;
}

function optimizeTripLocal({ factory, stops, matrix }) {
  const deliveries = stops.filter((s) => s.type === 'delivery');
  const pickups = stops.filter((s) => s.type === 'pickup');
  const deliveryPerms = permute(deliveries);
  const pickupPerms = permute(pickups);
  const allPoints = [factory, ...stops];
  const matrixMap = buildMatrixMap(allPoints, matrix);

  let best = null;
  let candidateCount = 0;

  deliveryPerms.forEach((dp) => {
    pickupPerms.forEach((pp) => {
      const route = [factory, ...dp, ...pp, factory];
      const score = evaluateRoute(route, matrixMap);
      candidateCount += 1;
      if (!best || score.durationSec < best.totalDurationSec) {
        best = {
          route,
          totalDurationSec: score.durationSec,
          totalDistanceM: score.distanceM,
        };
      }
    });
  });

  return {
    originalStops: stops,
    grouped: { deliveries, pickups },
    candidateCount,
    bestRoute: {
      pointIds: best.route.map((r) => r.id),
      stopIds: best.route.slice(1, -1).map((r) => r.id),
      orderedStops: best.route,
      totalDurationSec: best.totalDurationSec,
      totalDistanceM: best.totalDistanceM,
    },
    googleMapsUrl: buildGoogleMapsUrl(best.route),
  };
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (!h) return `${m} 分`;
  return `${h} 小時 ${m} 分`;
}

function renderTripsStops() {
  const body = $('tripStopsTbody');
  if (!body) return;
  body.innerHTML = '';
  tripStops.forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx + 1}</td><td>${s.name}</td><td>${s.type}</td><td>${s.relatedOrderId || '-'}</td><td>${s.address || '-'}</td><td><button class="btn" data-del-stop="${s.id}">刪除</button></td>`;
    body.append(tr);
  });
}

function renderManualRoute() {
  const wrap = $('tripManualRoute');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!manualRoute.length) {
    wrap.innerHTML = '<p class="sub">尚未有建議車趟，請先點擊「最佳化車趟」。</p>';
    return;
  }

  manualRoute.forEach((point, idx) => {
    const div = document.createElement('div');
    div.className = 'trip-route-item';
    const fixed = idx === 0 || idx === manualRoute.length - 1;
    div.innerHTML = `<strong>${idx + 1}. ${toPointLabel(point)}</strong><span>${point.type || 'factory'}</span><div>${fixed ? '<span class="sub">固定</span>' : `<button class="btn" data-route-up="${idx}">上移</button> <button class="btn" data-route-down="${idx}">下移</button>`}</div>`;
    wrap.append(div);
  });
}

function renderTripResult(result) {
  const box = $('tripResult');
  if (!box) return;
  if (!result) {
    box.innerHTML = '<p class="sub">尚未計算</p>';
    return;
  }
  box.innerHTML = `
    <p>候選路線：<strong>${result.candidateCount}</strong></p>
    <p>最佳順序：<strong>${result.bestRoute.orderedStops.map((s) => s.name).join(' → ')}</strong></p>
    <p>總預估時間：<strong>${formatDuration(result.bestRoute.totalDurationSec)}</strong></p>
    <p>總預估距離：<strong>${money(result.bestRoute.totalDistanceM)} m</strong></p>
    <p><a class="btn" href="${result.googleMapsUrl}" target="_blank" rel="noopener">開啟 Google Maps 導航</a></p>
  `;
}

function updateTripSummary() {
  $('tripStopsCount').textContent = String(tripStops.length);
  const d = tripStops.filter((s) => s.type === 'delivery').length;
  const p = tripStops.filter((s) => s.type === 'pickup').length;
  $('tripStopsTypeSummary').textContent = `delivery ${d} / pickup ${p}`;
}

function validateManualRoute(route) {
  const middle = route.slice(1, -1);
  let pickupSeen = false;
  for (const stop of middle) {
    if (stop.type === 'pickup') pickupSeen = true;
    if (pickupSeen && stop.type === 'delivery') return false;
  }
  return true;
}

function recalcManualRouteEstimate() {
  if (!lastOptimizeResult || !manualRoute.length) return;
  const matrixMap = buildMatrixMap(manualRoute, null);
  const score = evaluateRoute(manualRoute, matrixMap);
  $('tripManualHint').textContent = `手動路線預估：${formatDuration(score.durationSec)} / ${money(score.distanceM)} m`;
}

async function runOptimize() {
  const factory = {
    id: 'FACTORY',
    name: $('tripFactoryName').value.trim() || '工廠',
    address: $('tripFactoryAddress').value.trim() || '工廠',
    lat: Number($('tripFactoryLat').value),
    lng: Number($('tripFactoryLng').value),
  };

  if (!Number.isFinite(factory.lat) || !Number.isFinite(factory.lng)) {
    alert('請先填寫工廠座標 (lat/lng)');
    return;
  }

  const payload = { factory, stops: tripStops };
  try {
    const res = await fetch('/api/trips/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('api failed');
    const result = await res.json();
    result.bestRoute.orderedStops = result.bestRoute.orderedStops || result.bestRoute.pointIds?.map((id) => [factory, ...tripStops].find((p) => p.id === id)).filter(Boolean);
    lastOptimizeResult = result;
  } catch {
    lastOptimizeResult = optimizeTripLocal(payload);
  }

  manualRoute = (lastOptimizeResult.bestRoute.orderedStops || []).map((x) => ({ ...x }));
  renderTripResult(lastOptimizeResult);
  renderManualRoute();
  recalcManualRouteEstimate();
}

export function renderTrips() {
  renderTripsStops();
  updateTripSummary();
  renderManualRoute();
  renderTripResult(lastOptimizeResult);
}

export function bindTripEvents() {
  $('tripAddStopForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const stop = {
      id: crypto.randomUUID(),
      name: $('tripStopName').value.trim() || '未命名站點',
      address: $('tripStopAddress').value.trim(),
      lat: Number($('tripStopLat').value),
      lng: Number($('tripStopLng').value),
      type: $('tripStopType').value,
      relatedOrderId: $('tripRelatedOrderId').value.trim(),
      note: $('tripStopNote').value.trim(),
    };
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) {
      alert('請填寫正確站點座標');
      return;
    }
    tripStops.push(stop);
    e.target.reset();
    renderTrips();
  });

  $('tripStopsTbody')?.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del-stop]');
    if (!del) return;
    tripStops = tripStops.filter((s) => s.id !== del.dataset.delStop);
    renderTrips();
  });

  $('tripOptimizeBtn')?.addEventListener('click', runOptimize);
  $('tripClearBtn')?.addEventListener('click', () => {
    tripStops = [];
    lastOptimizeResult = null;
    manualRoute = [];
    $('tripManualHint').textContent = '手動調整後會顯示預估時間';
    renderTrips();
  });

  $('tripManualRoute')?.addEventListener('click', (e) => {
    const up = e.target.closest('button[data-route-up]');
    const down = e.target.closest('button[data-route-down]');
    if (!up && !down) return;

    const idx = Number((up || down).dataset.routeUp || (up || down).dataset.routeDown);
    const target = up ? idx - 1 : idx + 1;
    if (target <= 0 || target >= manualRoute.length - 1) return;
    const tmp = manualRoute[idx];
    manualRoute[idx] = manualRoute[target];
    manualRoute[target] = tmp;

    if (!validateManualRoute(manualRoute)) {
      const back = manualRoute[target];
      manualRoute[target] = manualRoute[idx];
      manualRoute[idx] = back;
      alert('不合法順序：pickup 不能排在 delivery 前面');
      return;
    }

    renderManualRoute();
    recalcManualRouteEstimate();
  });

  if (!$('tripFactoryLat').value) $('tripFactoryLat').value = '25.0103';
  if (!$('tripFactoryLng').value) $('tripFactoryLng').value = '121.4982';
  if (!$('tripFactoryName').value) $('tripFactoryName').value = '三青工廠';
}
