import { $, downloadCsv } from './shared.js';

export function getFilteredAudits(state) {
  const { start, end, keyword } = state.auditFilter;
  return state.audits.filter((a) => {
    const normalizedDate = (a.changedAt || '').slice(0, 10);
    if (start && normalizedDate && normalizedDate < start) return false;
    if (end && normalizedDate && normalizedDate > end) return false;
    if (!keyword) return true;
    const text = [a.orderNumber, a.field, a.user, a.device].join(' ').toLowerCase();
    return text.includes(keyword.toLowerCase());
  });
}

export function renderAudits(state) {
  const body = $('auditTbody');
  if (!body) return;
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
}

function applyAuditFilter(state) {
  state.auditFilter.start = $('auditStart').value;
  state.auditFilter.end = $('auditEnd').value;
  state.auditFilter.keyword = $('auditKeyword').value.trim();
  renderAudits(state);
}

export function bindAuditEvents(state) {
  $('applyAuditFilterBtn')?.addEventListener('click', () => applyAuditFilter(state));

  ['auditStart', 'auditEnd', 'auditKeyword'].forEach((id) => {
    $(id)?.addEventListener('input', () => applyAuditFilter(state));
    $(id)?.addEventListener('change', () => applyAuditFilter(state));
  });

  $('exportAuditBtn')?.addEventListener('click', () => {
    const rows = [['工單', '欄位', '修改前', '修改後', '時間', '操作者', '裝置/IP']];
    getFilteredAudits(state).forEach((a) => rows.push([a.orderNumber, a.field, a.before, a.after, a.changedAt, a.user, a.device]));
    downloadCsv('audit-log.csv', rows);
  });
}
