import { $, money } from '../shared.js';

export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小時 ${m} 分` : `${m} 分`;
}

export function renderCustomerOptions(customers) {
  const dl = $('tripCustomerOptions');
  if (!dl) return;
  dl.innerHTML = '';
  customers
    .filter((c) => c.active !== false)
    .forEach((c) => dl.append(new Option(c.name, c.name)));
}

export function renderStops(stops) {
  const body = $('tripStopsTbody');
  if (!body) return;
  body.innerHTML = '';
  stops.forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx + 1}</td><td>${s.name}</td><td>${s.type}</td><td>${s.relatedOrderId || '-'}</td><td>${s.address || '-'}</td><td><button class="btn" data-del-stop="${s.id}">刪除</button></td>`;
    body.append(tr);
  });
  $('tripStopsCount').textContent = String(stops.length);
  $('tripStopsTypeSummary').textContent = `delivery ${stops.filter((s) => s.type === 'delivery').length} / pickup ${stops.filter((s) => s.type === 'pickup').length}`;
}

export function renderResult(result) {
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

export function renderManualRoute(route, confirmed = false) {
  const wrap = $('tripManualRoute');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!route.length) {
    wrap.innerHTML = '<p class="sub">尚未有建議路線</p>';
    return;
  }

  route.forEach((s, idx) => {
    const fixed = idx === 0 || idx === route.length - 1;
    const div = document.createElement('div');
    div.className = `trip-route-item ${confirmed ? 'confirmed' : ''}`.trim();
    div.innerHTML = `<strong>${idx + 1}. ${s.name}</strong><span>${s.type || 'factory'}</span><div>${fixed ? '<span class="sub">固定</span>' : `<button class="btn" data-route-up="${idx}">上移</button> <button class="btn" data-route-down="${idx}">下移</button>`}</div>`;
    wrap.append(div);
  });
}
