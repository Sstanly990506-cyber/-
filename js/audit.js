import { $, downloadCsv } from './shared.js';

export function getFilteredAudits(state) {
  const { start, end, keyword, user = '', field = '', anomalyOnly = false } = state.auditFilter;
  return state.audits.filter((a) => {
    const normalizedDate = (a.changedAt || '').slice(0, 10);
    if (start && normalizedDate && normalizedDate < start) return false;
    if (end && normalizedDate && normalizedDate > end) return false;
    if (user && !String(a.user || '').toLowerCase().includes(user.toLowerCase())) return false;
    if (field && (a.field || '') !== field) return false;
    if (!keyword) return true;
    const text = [a.orderNumber, a.field, a.user, a.device, a.before, a.after].join(' ').toLowerCase();
    return text.includes(keyword.toLowerCase());
  }).filter((a) => (anomalyOnly ? isAnomalyAudit(a) : true));
}

function isAnomalyAudit(audit) {
  const before = Number(audit.before);
  const after = Number(audit.after);
  if (Number.isFinite(before) && Number.isFinite(after)) {
    const diff = Math.abs(after - before);
    if (before > 0 && diff / before >= 0.3) return true;
  }
  return /刪除|清空|取消|異常/i.test(String(audit.after || ''));
}

function renderAuditInsights(state) {
  const trendWrap = $('auditTrendBars');
  const anomalyWrap = $('auditAnomalyList');
  if (!trendWrap || !anomalyWrap) return;
  const filtered = getFilteredAudits(state);
  const trend = new Map();
  filtered.forEach((row) => {
    const key = String(row.changedAt || '').slice(0, 10) || '未填日期';
    trend.set(key, (trend.get(key) || 0) + 1);
  });
  const rows = [...trend.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10);
  const max = Math.max(1, ...rows.map(([, count]) => count));
  trendWrap.innerHTML = rows.length
    ? rows.map(([day, count]) => `<div class="chart-bar-row"><span>${day}</span><div class="chart-bar-track"><div class="chart-bar-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><strong>${count}</strong></div>`).join('')
    : '<p class="sub">目前無趨勢資料</p>';

  const anomalies = filtered.filter((row) => isAnomalyAudit(row)).slice(0, 8);
  anomalyWrap.innerHTML = anomalies.length
    ? anomalies.map((row) => `<li>${row.changedAt || '-'}｜${row.orderNumber || '-'}｜${row.field || '-'}：${row.before} → ${row.after}</li>`).join('')
    : '<li>目前未偵測到明顯異常。</li>';
}

function refreshFieldFilterOptions(state) {
  const select = $('auditFieldFilter');
  if (!select) return;
  const current = select.value;
  const fields = [...new Set(state.audits.map((a) => a.field).filter(Boolean))];
  select.innerHTML = '<option value="">全部欄位</option>' + fields.map((field) => `<option value="${field}">${field}</option>`).join('');
  select.value = fields.includes(current) ? current : '';
}

export function renderAudits(state) {
  const body = $('auditTbody');
  if (!body) return;
  refreshFieldFilterOptions(state);
  body.innerHTML = '';
  getFilteredAudits(state).forEach((a) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${a.orderNumber}</td>
      <td>${a.field}</td>
      <td>${a.before}</td>
      <td>${a.after}</td>
      <td>${a.changedAt}</td>
      <td>${a.user}</td>
      <td>${a.device}</td>`;
    body.append(tr);
  });
  renderAuditInsights(state);
}

function applyAuditFilter(state) {
  state.auditFilter.start = $('auditStart').value;
  state.auditFilter.end = $('auditEnd').value;
  state.auditFilter.field = $('auditFieldFilter')?.value || '';
  state.auditFilter.user = $('auditUserFilter')?.value?.trim() || '';
  state.auditFilter.anomalyOnly = $('auditAnomalyOnly')?.value === 'only';
  state.auditFilter.keyword = $('auditKeyword').value.trim();
  renderAudits(state);
}

export function bindAuditEvents(state, saveState, renderAll) {
  $('applyAuditFilterBtn')?.addEventListener('click', () => applyAuditFilter(state));

  ['auditStart', 'auditEnd', 'auditKeyword', 'auditFieldFilter', 'auditUserFilter', 'auditAnomalyOnly'].forEach((id) => {
    $(id)?.addEventListener('input', () => applyAuditFilter(state));
    $(id)?.addEventListener('change', () => applyAuditFilter(state));
  });

  $('exportAuditBtn')?.addEventListener('click', () => {
    const rows = [['工單', '欄位', '修改前', '修改後', '時間', '操作者', '裝置/IP']];
    getFilteredAudits(state).forEach((a) => rows.push([a.orderNumber, a.field, a.before, a.after, a.changedAt, a.user, a.device]));
    downloadCsv('audit-log.csv', rows);
  });

  $('auditImportFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rows = lines.slice(1).map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replaceAll('""', '"')));
    rows.forEach((row) => {
      const [orderNumber, field, before, after, changedAt, user, device] = row;
      if (!orderNumber && !field && !changedAt) return;
      state.audits.unshift({
        id: crypto.randomUUID(),
        orderNumber: orderNumber || '(外部資料)',
        field: field || '外部欄位',
        before: before || '',
        after: after || '',
        changedAt: changedAt || new Date().toLocaleString(),
        user: user || 'external',
        device: device || 'external-import',
      });
    });
    e.target.value = '';
    saveState();
    renderAll();
  });
}
