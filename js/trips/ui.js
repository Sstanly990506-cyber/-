import { $, escapeHtml } from '../shared.js';

export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小時 ${m} 分` : `${m} 分`;
}

export function formatDistance(meters) {
  const kilometers = Math.max(0, Number(meters || 0)) / 1000;
  return `${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 }).format(kilometers)} 公里`;
}

function stopTypeLabel(type) {
  if (type === 'pickup') return '載貨';
  if (type === 'delivery') return '送貨';
  return '工廠';
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
    tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(stopTypeLabel(s.type))}</td><td>${escapeHtml(s.relatedOrderId || '-')}</td><td>${escapeHtml(s.address || '-')}</td><td><button class="btn" data-del-stop="${escapeHtml(s.id)}">刪除</button></td>`;
    body.append(tr);
  });
  $('tripStopsCount').textContent = String(stops.length);
  $('tripStopsTypeSummary').textContent = `送貨 ${stops.filter((s) => s.type === 'delivery').length} / 載貨 ${stops.filter((s) => s.type === 'pickup').length}`;
}

export function renderResult(result) {
  const box = $('tripResult');
  if (!box) return;
  if (!result) {
    box.innerHTML = '<p class="sub">尚未產生建議路線。</p>';
    return;
  }

  const routeNames = result.bestRoute.orderedStops.map((s) => s.name).join(' → ');
  box.innerHTML = `
    <p>候選路線數：<strong>${result.candidateCount}</strong></p>
    <p>建議順序：<strong>${escapeHtml(routeNames)}</strong></p>
    <p>預估時間：<strong>${formatDuration(result.bestRoute.totalDurationSec)}</strong></p>
    <p>預估距離：<strong>${formatDistance(result.bestRoute.totalDistanceM)}</strong></p>
    <p><a class="btn" href="${escapeHtml(result.googleMapsUrl)}" target="_blank" rel="noopener">用 Google Maps 開啟</a></p>
  `;
}

export function renderManualRoute(route, confirmed = false) {
  const wrap = $('tripManualRoute');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!route.length) {
    wrap.innerHTML = '<p class="sub">尚未產生手動路線。</p>';
    return;
  }

  route.forEach((s, idx) => {
    const fixed = idx === 0 || idx === route.length - 1;
    const div = document.createElement('div');
    div.className = `trip-route-item ${confirmed ? 'confirmed' : ''}`.trim();
    div.innerHTML = `<strong>${idx + 1}. ${escapeHtml(s.name)}</strong><span>${escapeHtml(stopTypeLabel(s.type || 'factory'))}</span><div>${fixed ? '<span class="sub">固定點</span>' : `<button class="btn" data-route-up="${idx}">上移</button> <button class="btn" data-route-down="${idx}">下移</button>`}</div>`;
    wrap.append(div);
  });
}
