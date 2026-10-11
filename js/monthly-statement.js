import { escapeHtml } from './shared.js';

const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const key = value => String(value || '').trim().toLocaleLowerCase();
const format = value => value == null ? '-' : Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 4 });

export async function fetchStatementRecords(entity, token, query = '', request = fetch) {
  const rows = new Map();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const response = await request(`/api/data/${entity}?page=${page}&pageSize=100&q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error(`月帳單資料讀取失敗（HTTP ${response.status}），請重新登入或稍後再試。`);
    const data = await response.json();
    pages = Math.max(1, Number(data.pages) || 1);
    for (const row of data.items || []) rows.set(row.id, row);
  }
  return [...rows.values()];
}

export function buildMonthlyStatement(state, { customerId, month, taxRate = 5, includePending = false } = {}) {
  const customer = (state.customers || []).find(row => row.id === customerId);
  if (!customer) throw new Error('請選擇一位客戶，避免不同公司的工單混在一起。');
  if ((state.customers || []).filter(row => key(row.name) === key(customer.name)).length > 1) throw new Error('有同名客戶，請先整理客戶名稱，避免混入其他公司的帳單。');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('請選擇正確的帳單月份。');
  if (!Number.isFinite(Number(taxRate)) || Number(taxRate) < 0 || Number(taxRate) > 100) throw new Error('稅率須介於 0 到 100。');
  const rows = (state.orders || [])
    .filter(order => key(order.billingCustomer || order.upstream) === key(customer.name))
    .filter(order => String(order.orderDate || '').slice(0, 7) === month)
    .filter(order => includePending || ['已完成', '已送出'].includes(order.status))
    .sort((a, b) => String(a.orderDate).localeCompare(String(b.orderDate)) || String(a.orderNumber).localeCompare(String(b.orderNumber)))
    .map(order => ({
      id: order.id, date: order.orderDate, orderNumber: order.orderNumber || '',
      itemName: order.itemName || '', processing: order.glossType || '',
      length: number(order.sizeLength), width: number(order.sizeWidth), sizeUnit: order.sizeUnit || '',
      quantity: number(order.sheetCount), quantityNote: order.sheetCountText || '',
      unitPrice: order.unitPrice == null || order.unitPrice === '' ? null : number(order.unitPrice),
      priceUnit: order.pricingMode === 'sheet' ? '元／張' : order.pricingMode === 'ream' ? '元／令' : '',
      amount: number(order.totalPrice), destination: order.downstream || order.address || '', address: order.address || '',
    }));
  const subtotal = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const tax = Math.round(subtotal * Number(taxRate) / 100);
  return { customer, month, rows, subtotal, tax, total: subtotal + tax, taxRate: Number(taxRate),
    warnings: rows.flatMap(row => [
      ...(!row.itemName ? [`${row.orderNumber}：尚未填品名`] : []),
      ...(row.unitPrice == null ? [`${row.orderNumber}：尚未記錄單價`] : []),
      ...(!row.quantity ? [`${row.orderNumber}：尚未填計算張數`] : []),
      ...(!row.amount ? [`${row.orderNumber}：估價為 0，請確認`] : []),
    ]),
  };
}

export function statementTableHtml(statement) {
  const rows = statement.rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.orderNumber)}${row.itemName ? `<br>${escapeHtml(row.itemName)}` : ''}</td><td>${escapeHtml(row.processing || '-')}</td><td>${format(row.length)} × ${format(row.width)} ${escapeHtml(row.sizeUnit === 'tai-inch' ? '台吋' : row.sizeUnit)}</td><td class="numeric">${format(row.quantity)}</td><td class="numeric">${format(row.unitPrice)}${row.priceUnit ? `<br><small>${escapeHtml(row.priceUnit)}</small>` : ''}</td><td class="numeric">${format(row.amount)}</td><td>${escapeHtml(row.destination || '-')}</td></tr>`).join('');
  return `<table class="monthly-statement-table"><thead><tr><th>日期</th><th>工單／品名</th><th>加工</th><th>尺寸（天 × 地）</th><th>數量</th><th>單價</th><th>估價</th><th>送貨地點</th></tr></thead><tbody>${rows || '<tr><td colspan="8">這個月沒有符合條件的工單。</td></tr>'}</tbody></table>`;
}

export function statementPrintHtml(statement, company) {
  const customer = statement.customer;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>${escapeHtml(customer.name)} ${escapeHtml(statement.month)} 月帳單</title><style>
  @page{size:A4 portrait;margin:12mm}body{font-family:Arial,"Microsoft JhengHei",sans-serif;color:#111;font-size:12px}h1{text-align:center;font-size:24px;margin:0 0 20px}.meta,.footer{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin:16px 0}.meta p,.footer p{margin:4px 0}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #444;padding:6px 4px;text-align:left;overflow-wrap:anywhere}.numeric{text-align:right;white-space:nowrap}thead{display:table-header-group}tr{break-inside:avoid}.total{text-align:right;font-size:14px}.actions{text-align:right;margin-bottom:16px}@media print{.actions{display:none}}
  </style></head><body><div class="actions"><button onclick="window.print()">列印／另存 PDF</button></div><h1>${escapeHtml(company.name)}月帳單報表</h1>
  <div class="meta"><div><p>客戶名稱：${escapeHtml(customer.name)}</p><p>計費期間：${escapeHtml(statement.month)}</p><p>地址：${escapeHtml(customer.address || '-')}</p></div><div><p>電話：${escapeHtml(customer.phone || '-')}</p><p>傳真：${escapeHtml(customer.fax || '-')}</p><p>統一編號：${escapeHtml(customer.taxId || '-')}</p></div></div>
  ${statementTableHtml(statement)}<div class="footer"><div><p>工作筆數：${statement.rows.length}</p><p>電話：${escapeHtml(company.phone || '-')}</p><p>傳真：${escapeHtml(company.fax || '-')}</p><p>地址：${escapeHtml(company.address || '-')}</p></div><div class="total"><p>總合：${format(statement.subtotal)}</p><p>稅額（${format(statement.taxRate)}%）：${format(statement.tax)}</p><p><strong>應付金額：${format(statement.total)}</strong></p></div></div></body></html>`;
}
