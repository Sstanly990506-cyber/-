import { $, downloadCsv, escapeHtml } from './shared.js';

let aiCorrectionsCache = [];

const AI_FIELD_LABELS = {
  orderNumber: '工單編號',
  orderDate: '交貨日期',
  billingCustomer: '客人',
  upstream: '上游客戶',
  downstream: '下游客戶',
  address: '送貨地址',
  sheetCountText: '數量說明',
  sheetCount: '計算張數',
  sizeLength: '天',
  sizeWidth: '地',
  sizeUnit: '單位',
  glossType: '上光種類',
  totalPrice: '總價',
};

function correctionRows(correction) {
  return Object.entries(correction?.changes || {}).map(([field, value]) => ({
    id: correction.id,
    field,
    fieldLabel: AI_FIELD_LABELS[field] || field,
    wrong: value?.wrong ?? '',
    correct: value?.correct ?? '',
    confidence: correction.confidence,
    reportedAt: correction.reportedAt,
    reportedBy: correction.reportedBy || '-',
  }));
}

export function renderAiCorrectionCenter(rows = aiCorrectionsCache) {
  const body = $('aiCorrectionsTbody');
  const summary = $('aiCorrectionsSummary');
  if (!body) return;
  const flatRows = rows.flatMap(correctionRows);
  if (summary) summary.textContent = `已記錄 ${rows.length} 筆修正案例，${flatRows.length} 個欄位。`;
  body.innerHTML = flatRows.length ? flatRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.fieldLabel)}</td>
      <td>${escapeHtml(row.wrong || '-')}</td>
      <td>${escapeHtml(row.correct || '-')}</td>
      <td>${row.confidence ? `${Math.round(Number(row.confidence) * 100)}%` : '-'}</td>
      <td>${row.reportedAt ? new Date(Number(row.reportedAt)).toLocaleString() : '-'}</td>
      <td>${escapeHtml(row.reportedBy)}</td>
      <td><button class="btn small ghost" type="button" data-delete-ai-correction="${escapeHtml(row.id)}">刪除</button></td>
    </tr>`).join('') : '<tr><td colspan="7">目前還沒有 AI 修正紀錄。</td></tr>';
}

export async function loadAiCorrections(state) {
  if (state.settings?.moduleInternals?.orders?.showAiTools === false) return;
  const body = $('aiCorrectionsTbody');
  if (body) body.innerHTML = '<tr><td colspan="7">正在載入修正紀錄…</td></tr>';
  const res = await fetch('/api/data/aiCorrections?page=1&pageSize=100', {
    headers: { Authorization: `Bearer ${state.authToken || ''}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  aiCorrectionsCache = data.items || [];
  renderAiCorrectionCenter();
}

export function exportAiCorrections() {
  const rows = [['欄位', 'AI 原本辨識', '修正後', '信心度', '回報時間', '回報人']];
  aiCorrectionsCache.flatMap(correctionRows).forEach((row) => rows.push([
    row.fieldLabel,
    row.wrong,
    row.correct,
    row.confidence ? `${Math.round(Number(row.confidence) * 100)}%` : '',
    row.reportedAt ? new Date(Number(row.reportedAt)).toLocaleString() : '',
    row.reportedBy,
  ]));
  downloadCsv('AI-修正中心.csv', rows);
}

