import { $, money, escapeHtml } from '../shared.js';

export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 撠? ${m} ? : `${m} ?;
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
    tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.type)}</td><td>${escapeHtml(s.relatedOrderId || '-')}</td><td>${escapeHtml(s.address || '-')}</td><td><button class="btn" data-del-stop="${escapeHtml(s.id)}">?芷</button></td>`;
    body.append(tr);
  });
  $('tripStopsCount').textContent = String(stops.length);
  $('tripStopsTypeSummary').textContent = `delivery ${stops.filter((s) => s.type === 'delivery').length} / pickup ${stops.filter((s) => s.type === 'pickup').length}`;
}

export function renderResult(result) {
  const box = $('tripResult');
  if (!box) return;
  if (!result) {
    box.innerHTML = '<p class="sub">撠閮?</p>';
    return;
  }

  box.innerHTML = `
    <p>?頝舐?嚗?strong>${result.candidateCount}</strong></p>
    <p>?雿喲?摨?<strong>${escapeHtml(result.bestRoute.orderedStops.map((s) => s.name).join(' ??'))}</strong></p>
    <p>蝮賡?隡唳???<strong>${formatDuration(result.bestRoute.totalDurationSec)}</strong></p>
    <p>蝮賡?隡啗??ｇ?<strong>${money(result.bestRoute.totalDistanceM)} m</strong></p>
    <p><a class="btn" href="${escapeHtml(result.googleMapsUrl)}" target="_blank" rel="noopener">?? Google Maps 撠</a></p>
  `;
}

export function renderManualRoute(route, confirmed = false) {
  const wrap = $('tripManualRoute');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!route.length) {
    wrap.innerHTML = '<p class="sub">撠?遣霅啗楝蝺?/p>';
    return;
  }

  route.forEach((s, idx) => {
    const fixed = idx === 0 || idx === route.length - 1;
    const div = document.createElement('div');
    div.className = `trip-route-item ${confirmed ? 'confirmed' : ''}`.trim();
    div.innerHTML = `<strong>${idx + 1}. ${escapeHtml(s.name)}</strong><span>${escapeHtml(s.type || 'factory')}</span><div>${fixed ? '<span class="sub">?箏?</span>' : `<button class="btn" data-route-up="${idx}">銝宏</button> <button class="btn" data-route-down="${idx}">銝宏</button>`}</div>`;
    wrap.append(div);
  });
}
