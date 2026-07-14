import { $, COMPANY_INFO, money, downloadCsv, getTodayText, escapeHtml } from './shared.js';
import { getOrderReceivableKey } from './store.js';
import { toTaiInch } from './pricing.js';

const selectedInvoiceOrderIds = new Set();

// escapeHtml(value) is imported from shared.js so finance output uses one sanitizer.

function inRange(state, dateText) {
  const { start, end } = state.reportRange;
  if (!dateText) return true;
  if (start && dateText < start) return false;
  if (end && dateText > end) return false;
  return true;
}

function getInvoiceEligibleOrders(state) {
  return state.orders.filter((o) => ['未完成', '進行中'].includes(o.status || '未完成'));
}

function getSelectedInvoiceOrders(state) {
  const idSet = new Set(getInvoiceEligibleOrders(state).map((o) => o.id));
  [...selectedInvoiceOrderIds].forEach((id) => {
    if (!idSet.has(id)) selectedInvoiceOrderIds.delete(id);
  });
  return state.orders.filter((o) => selectedInvoiceOrderIds.has(o.id));
}

function getInvoiceMeta() {
  return {
    date: $('invoiceDate')?.value || getTodayText(),
    number: $('invoiceNumber')?.value.trim() || '',
    buyerName: $('invoiceBuyerName')?.value.trim() || '',
    buyerTaxId: $('invoiceBuyerTaxId')?.value.trim() || '',
    buyerAddress: $('invoiceBuyerAddress')?.value.trim() || '',
    note: $('invoiceNote')?.value.trim() || '',
  };
}


function findOrderByNumber(state, key) {
  const text = (key || '').trim().toLowerCase();
  if (!text) return null;
  return state.orders.find((o) => (o.orderNumber || '').trim().toLowerCase() === text)
    || state.orders.find((o) => (o.orderNumber || '').toLowerCase().includes(text));
}

function updateFinanceSmartHint(state) {
  const hint = $('financeSmartHint');
  if (!hint) return;
  const order = findOrderByNumber(state, $('recvOrderNumber')?.value || '');
  if (!order) {
    hint.textContent = '輸入工單編號後，系統會自動帶入客人、日期與金額。';
    return;
  }
  hint.textContent = `已找到工單 ${order.orderNumber || '-'}，可自動帶入應收款資料。`;
}

function autofillReceivableFromOrder(state) {
  const order = findOrderByNumber(state, $('recvOrderNumber')?.value || '');
  if (!order) return updateFinanceSmartHint(state);
  if ($('recvCustomer') && !$('recvCustomer').value.trim()) $('recvCustomer').value = order.billingCustomer || order.downstream || order.upstream || '';
  if ($('recvAmount') && Number($('recvAmount').value || 0) <= 0) $('recvAmount').value = String(Number(order.totalPrice || 0));
  if ($('recvDate') && !$('recvDate').value) $('recvDate').value = order.orderDate || getTodayText();
  updateFinanceSmartHint(state);
}

function applyInvoiceBuyerBySelection(state) {
  const selected = getSelectedInvoiceOrders(state);
  if (!selected.length) return;
  const customerNames = selected.map((o) => o.billingCustomer || o.downstream || o.upstream || '').filter(Boolean);
  if (!customerNames.length) return;
  const count = new Map();
  customerNames.forEach((n) => count.set(n, (count.get(n) || 0) + 1));
  const [bestName] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const customer = state.customers.find((c) => (c.name || '').trim() === bestName);
  if ($('invoiceBuyerName') && !$('invoiceBuyerName').value.trim()) $('invoiceBuyerName').value = bestName;
  if ($('invoiceBuyerTaxId') && customer?.taxId && !$('invoiceBuyerTaxId').value.trim()) $('invoiceBuyerTaxId').value = customer.taxId;
  if ($('invoiceBuyerAddress') && customer?.address && !$('invoiceBuyerAddress').value.trim()) $('invoiceBuyerAddress').value = customer.address;
}

function renderInvoiceMeta(meta) {
  return `<div class="meta">
    <div>發票日期：${escapeHtml(meta.date || '-')}</div>
    <div>發票號碼：${escapeHtml(meta.number || '-')}</div>
    <div>買方名稱：${escapeHtml(meta.buyerName || '-')}</div>
    <div>買方統編：${escapeHtml(meta.buyerTaxId || '-')}</div>
    <div style="grid-column:1 / -1;">買方地址：${escapeHtml(meta.buyerAddress || '-')}</div>
    <div style="grid-column:1 / -1;">備註：${escapeHtml(meta.note || '-')}</div>
  </div>`;
}

function renderInvoicePicker(state) {
  const wrap = $('invoiceOrdersList');
  const summary = $('invoiceSelectSummary');
  if (!wrap || !summary) return;
  wrap.innerHTML = '';

  const orders = getInvoiceEligibleOrders(state);
  if (!orders.length) {
    wrap.innerHTML = '<p class="sub">目前沒有可開發票的工單。</p>';
    summary.textContent = '已選 0 筆，總價 0 元';
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement('label');
    row.className = 'invoice-order-item';
    row.innerHTML = `
      <input type="checkbox" data-invoice-order-id="${escapeHtml(order.id)}" ${selectedInvoiceOrderIds.has(order.id) ? 'checked' : ''} />
      <strong>${escapeHtml(order.orderNumber || '未命名工單')}</strong>
      <span>${escapeHtml(order.billingCustomer || order.downstream || order.upstream || '-')}</span>
      <span>${escapeHtml(order.orderDate || '-')}</span>
      <span>NT$ ${money(order.totalPrice || 0)}</span>`;
    wrap.append(row);
  });

  const selected = getSelectedInvoiceOrders(state);
  const total = selected.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  summary.textContent = `已選 ${selected.length} 筆，總價 ${money(total)} 元`;
}

function openInvoiceWindow(state) {
  const selected = getSelectedInvoiceOrders(state);
  if (!selected.length) {
    alert('請先選擇要開發票的工單。');
    return;
  }
  const meta = getInvoiceMeta();
  const total = selected.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  const rows = selected
    .map((o, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(o.orderNumber || '-')}</td><td>${escapeHtml(o.billingCustomer || o.downstream || o.upstream || '-')}</td><td>${escapeHtml(o.orderDate || '-')}</td><td style="text-align:right;">${money(o.totalPrice || 0)}</td></tr>`)
    .join('');

  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8" /><title>發票預覽</title>
  <style>body{font-family:"Noto Sans TC",sans-serif;padding:16px}.copy{border:2px solid #555;padding:12px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #777;padding:6px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}.sum{font-weight:700;text-align:right}</style></head><body>
  <div class="copy"><h2>${escapeHtml(COMPANY_INFO.name)} 發票</h2><p>${escapeHtml(COMPANY_INFO.address)}</p>${renderInvoiceMeta(meta)}<table><thead><tr><th>#</th><th>工單</th><th>客人</th><th>日期</th><th>金額</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">總計：NT$ ${money(total)}</div></div>
  <script>window.print();</script></body></html>`;

  const win = window.open('', '_blank', 'width=980,height=760');
  if (!win) return alert('請允許瀏覽器開啟彈出視窗。');
  win.document.write(html);
  win.document.close();
}

export function getLinkedReceivablesData(state) {
  const orderMap = new Map();

  state.orders
    .filter((o) => ['未完成', '進行中'].includes(o.status || '未完成'))
    .filter((o) => inRange(state, o.orderDate))
    .forEach((o) => {
      const key = getOrderReceivableKey(o);
      orderMap.set(key, {
        key,
        date: o.orderDate || '',
        customer: o.billingCustomer || o.downstream || o.upstream || '-',
        orderNumber: key,
        amount: Number(o.totalPrice || 0),
        received: 0,
      });
    });

  state.receivables
    .filter((item) => inRange(state, item.date || ''))
    .forEach((item) => {
      const key = (item.orderNumber || '').trim() || item.id;
      const linked = orderMap.get(key);
      if (linked) {
        linked.date = item.date || linked.date;
        linked.customer = item.customer || linked.customer;
        linked.amount = Number(item.amount || linked.amount || 0);
        linked.received = Number(item.received || 0);
        return;
      }
      orderMap.set(key, {
        key,
        date: item.date || '',
        customer: item.customer || '-',
        orderNumber: item.orderNumber || '(未命名工單)',
        amount: Number(item.amount || 0),
        received: Number(item.received || 0),
      });
    });

  return [...orderMap.values()].map((item) => {
    const remain = Math.max(0, Number(item.amount) - Number(item.received));
    const age = item.date ? Math.floor((Date.now() - new Date(item.date).getTime()) / 86400000) : 0;
    return { ...item, remain, age };
  });
}

function getReportBData(state) {
  return state.orders.filter((o) => inRange(state, o.orderDate)).map((o) => {
    const revenue = Number(o.totalPrice || 0);
    const cost = Math.round(revenue * 0.7);
    return { orderNumber: o.orderNumber, customer: o.billingCustomer || o.downstream || o.upstream, revenue, cost, gross: revenue - cost };
  });
}

function getReportCData(state) {
  const map = new Map();
  state.receivables.filter((r) => inRange(state, r.date)).forEach((r) => {
    const month = (r.date || '').slice(0, 7) || '?芸‵?交?';
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).income += Number(r.received || 0);
  });
  state.payables.filter((p) => inRange(state, p.date)).forEach((p) => {
    const month = (p.date || '').slice(0, 7) || '?芸‵?交?';
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).expense += Number(p.paid || 0);
  });
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month)).map((m) => ({ ...m, net: m.income - m.expense }));
}

function currentMonthText() {
  return new Date().toISOString().slice(0, 7);
}

function getMonthCloseData(state, reportA, month) {
  const target = month || currentMonthText();
  const receivables = reportA.filter((r) => (r.date || '').slice(0, 7) === target);
  const payables = state.payables
    .filter((p) => (p.date || '').slice(0, 7) === target)
    .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }));
  const receivableTotal = receivables.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const receivedTotal = receivables.reduce((sum, r) => sum + Number(r.received || 0), 0);
  const payableTotal = payables.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const paidTotal = payables.reduce((sum, p) => sum + Number(p.paid || 0), 0);
  return {
    month: target,
    receivables,
    payables,
    receivableTotal,
    receivedTotal,
    receivableUnpaid: Math.max(0, receivableTotal - receivedTotal),
    payableTotal,
    paidTotal,
    payableUnpaid: Math.max(0, payableTotal - paidTotal),
    cashNet: receivedTotal - paidTotal,
  };
}

function renderMonthClose(state, reportA) {
  const monthInput = $('financeCloseMonth');
  if (monthInput && !monthInput.value) monthInput.value = currentMonthText();
  const data = getMonthCloseData(state, reportA, monthInput?.value);
  if ($('financeMonthSummary')) {
    $('financeMonthSummary').textContent = `${data.month} ??嚗歇??${money(data.receivedTotal)}嚗歇隞?${money(data.paidTotal)}嚗楊?暸? ${money(data.cashNet)}嚗??${money(data.receivableUnpaid)}嚗隞?${money(data.payableUnpaid)}`;
  }
  if ($('financeMonthCloseTbody')) {
    $('financeMonthCloseTbody').innerHTML = `
      <tr>
        <td>${escapeHtml(data.month)}</td>
        <td>${money(data.receivableTotal)}</td>
        <td>${money(data.receivedTotal)}</td>
        <td>${money(data.payableTotal)}</td>
        <td>${money(data.paidTotal)}</td>
        <td>${money(data.cashNet)}</td>
      </tr>`;
  }
  return data;
}

function getCustomerStatementRows(state, reportA) {
  const customer = ($('statementCustomer')?.value || '').trim();
  const month = $('financeCloseMonth')?.value || currentMonthText();
  if (!customer) return { customer, month, rows: [] };
  const key = customer.toLowerCase();
  const rows = reportA
    .filter((r) => (r.date || '').slice(0, 7) === month)
    .filter((r) => String(r.customer || '').toLowerCase().includes(key))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return { customer, month, rows };
}

function exportMonthClose(state, reportA) {
  const data = getMonthCloseData(state, reportA, $('financeCloseMonth')?.value);
  const rows = [
    ['月份', '應收', '已收', '未收', '應付', '已付', '未付', '現金淨額'],
    [data.month, data.receivableTotal, data.receivedTotal, data.receivableUnpaid, data.payableTotal, data.paidTotal, data.payableUnpaid, data.cashNet],
    [],
    ['應收客戶', '工單', '日期', '應收', '已收', '未收'],
    ...data.receivables.filter((r) => r.remain > 0).map((r) => [r.customer, r.orderNumber, r.date, r.amount, r.received, r.remain]),
    [],
    ['應付廠商', '項目', '日期', '應付', '已付', '未付'],
    ...data.payables.filter((p) => p.unpaid > 0).map((p) => [p.vendor, p.item, p.date, p.amount, p.paid, p.unpaid]),
  ];
  downloadCsv(`month-close-${data.month}.csv`, rows);
}

function exportCustomerStatement(state, reportA) {
  const statement = getCustomerStatementRows(state, reportA);
  if (!statement.customer) return alert('請先輸入客人關鍵字。');
  if (!statement.rows.length) return alert('這個月份沒有符合條件的對帳資料。');
  const totals = statement.rows.reduce((acc, r) => {
    acc.amount += Number(r.amount || 0);
    acc.received += Number(r.received || 0);
    acc.remain += Number(r.remain || 0);
    return acc;
  }, { amount: 0, received: 0, remain: 0 });
  downloadCsv(`statement-${statement.customer}-${statement.month}.csv`, [
    ['客人', statement.customer],
    ['月份', statement.month],
    ['應收總額', totals.amount],
    ['已收總額', totals.received],
    ['未收總額', totals.remain],
    [],
    ['日期', '工單', '應收', '已收', '未收'],
    ...statement.rows.map((r) => [r.date, r.orderNumber, r.amount, r.received, r.remain]),
  ]);
}

function printCustomerStatement(state, reportA) {
  const statement = getCustomerStatementRows(state, reportA);
  if (!statement.customer) return alert('請先輸入客人關鍵字。');
  if (!statement.rows.length) return alert('這個月份沒有符合條件的對帳資料。');
  const totals = statement.rows.reduce((acc, r) => {
    acc.amount += Number(r.amount || 0);
    acc.received += Number(r.received || 0);
    acc.remain += Number(r.remain || 0);
    return acc;
  }, { amount: 0, received: 0, remain: 0 });
  const rows = statement.rows.map((r) => `<tr><td>${escapeHtml(r.date || '-')}</td><td>${escapeHtml(r.orderNumber || '-')}</td><td>${money(r.amount)}</td><td>${money(r.received)}</td><td>${money(r.remain)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8" /><title>客戶對帳單</title>
  <style>body{font-family:"Noto Sans TC",sans-serif;padding:18px;color:#111}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #777;padding:7px;text-align:left}.sum{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px;font-weight:700}</style></head><body>
  <h2>${escapeHtml(COMPANY_INFO.name)} 客戶對帳單</h2>
  <p>客人：${escapeHtml(statement.customer)}　月份：${escapeHtml(statement.month)}</p>
  <div class="sum"><span>應收：${money(totals.amount)}</span><span>已收：${money(totals.received)}</span><span>未收：${money(totals.remain)}</span></div>
  <table><thead><tr><th>日期</th><th>工單</th><th>應收</th><th>已收</th><th>未收</th></tr></thead><tbody>${rows}</tbody></table>
  <script>window.print();</script></body></html>`;
  const win = window.open('', '_blank', 'width=980,height=760');
  if (!win) return alert('請允許瀏覽器開啟彈出視窗。');
  win.document.write(html);
  win.document.close();
}

function renderFinanceInsights(state, reportA) {
  const received = reportA.reduce((sum, r) => sum + Number(r.received || 0), 0);
  const unreceived = reportA.reduce((sum, r) => sum + Number(r.remain || 0), 0);
  $('financeRecvSummary').textContent = `${money(received)} / ${money(unreceived)}`;

  const recent = [...state.audits].slice(0, 5);
  const recentWrap = $('financeRecentChanges');
  recentWrap.innerHTML = recent.length
    ? recent.map((a) => `<li>${escapeHtml(a.changedAt || '-')}嚚?{escapeHtml(a.orderNumber || '-')}嚚?{escapeHtml(a.field || '-')}嚗?{escapeHtml(a.before)} ??${escapeHtml(a.after)}</li>`).join('')
    : '<li>?桀?瘝??啣?蝝??/li>';

  const dueLimit = new Date();
  dueLimit.setDate(dueLimit.getDate() + 7);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.date && new Date(r.date) <= dueLimit).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  $('financeDueSoonCount').textContent = String(dueSoon.length);
  const dueWrap = $('financeDueSoonList');
  dueWrap.innerHTML = dueSoon.length
    ? dueSoon.map((r) => `<li>${escapeHtml(r.date)}嚚?{escapeHtml(r.customer)}嚚?{escapeHtml(r.orderNumber)}嚚??${money(r.remain)}</li>`).join('')
    : '<li>7 ?亙?∪翰?唳?撣單狡</li>';
}

function renderFinanceChartAndAnalysis(reportC, reportA) {
  const wrap = $('financeChartBars');
  const analysis = $('financeAnalysisList');
  if (!wrap || !analysis) return;
  const recent = [...reportC].sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  const maxNet = Math.max(1, ...recent.map((row) => Math.abs(Number(row.net || 0))));
  wrap.innerHTML = recent.length
    ? recent.map((row) => {
      const net = Number(row.net || 0);
      const width = Math.round((Math.abs(net) / maxNet) * 100);
      return `<div class="chart-bar-row"><span>${escapeHtml(row.month)}</span><div class="chart-bar-track"><div class="chart-bar-fill ${net < 0 ? 'neg' : ''}" style="width:${width}%"></div></div><strong>${money(net)}</strong></div>`;
    }).join('')
    : '<p class="sub">?桀?瘝??鞈?</p>';

  const totalRecv = reportA.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalReceived = reportA.reduce((sum, row) => sum + Number(row.received || 0), 0);
  const collectionRate = totalRecv > 0 ? (totalReceived / totalRecv) * 100 : 0;
  const avgNet = recent.length ? recent.reduce((sum, row) => sum + Number(row.net || 0), 0) / recent.length : 0;
  $('financeCollectionRate').textContent = `${collectionRate.toFixed(1)}%`;
  $('financeAvgNet6m').textContent = money(Math.round(avgNet));

  const insights = [];
  if (avgNet < 0) insights.push('近 6 個月平均淨額為負，建議檢查成本與應付款。');
  if (collectionRate < 70) insights.push(`收款率 ${collectionRate.toFixed(1)}% 偏低，建議優先追蹤未收款。`);
  const topOverdue = [...reportA].filter((r) => r.remain > 0).sort((a, b) => b.remain - a.remain).slice(0, 3);
  if (topOverdue.length) insights.push(`未收金額最高 3 筆：${topOverdue.map((r) => `${r.customer}/${money(r.remain)}`).join('、')}`);
  analysis.innerHTML = (insights.length ? insights : ['目前財務狀況正常，請持續追蹤收付款。']).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}


function renderFinanceQuickActions(state, reportA) {
  const receivableWrap = $('financeReceivableActions');
  const payableWrap = $('financePayableActions');
  if (receivableWrap) {
    const rows = reportA.filter((r) => r.remain > 0).sort((a, b) => b.remain - a.remain).slice(0, 8);
    receivableWrap.innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.customer || '-')}</td>
        <td>${escapeHtml(r.orderNumber || '-')}</td>
        <td>${money(r.remain)}</td>
        <td class="table-actions">
          <button class="btn small" type="button" data-finance-receivable-done="${escapeHtml(r.key)}">?嗆?</button>
          <button class="btn small ghost" type="button" data-finance-receivable-delete="${escapeHtml(r.key)}">?芷</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="4">?桀?瘝?敺甈整?/td></tr>';
  }
  if (payableWrap) {
    const rows = state.payables
      .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }))
      .filter((p) => p.unpaid > 0)
      .sort((a, b) => b.unpaid - a.unpaid)
      .slice(0, 8);
    payableWrap.innerHTML = rows.length ? rows.map((p) => `
      <tr>
        <td>${escapeHtml(p.vendor || '-')}</td>
        <td>${escapeHtml(p.item || '-')}</td>
        <td>${money(p.unpaid)}</td>
        <td class="table-actions">
          <button class="btn small" type="button" data-finance-payable-done="${escapeHtml(p.id)}">隞?</button>
          <button class="btn small ghost" type="button" data-finance-payable-delete="${escapeHtml(p.id)}">?芷</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="4">?桀?瘝?敺?甈整?/td></tr>';
  }
}


function buildTodayAlerts(state, reportA) {
  const today = new Date().toISOString().slice(0, 10);
  const unpaidToday = state.payables.filter((p) => (p.date || '').slice(0, 10) === today && Number(p.amount || 0) > Number(p.paid || 0));
  const auditToday = state.audits.filter((a) => String(a.changedAt || '').includes(today));
  const dueLimit = new Date();
  dueLimit.setDate(dueLimit.getDate() + 1);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.date && new Date(r.date) <= dueLimit);

  const alerts = [];
  unpaidToday.forEach((p) => alerts.push(`???芯?嚗?{p.vendor || '-'} / ${p.item || '-'} / ?芯? ${money(Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)))}`));
  dueSoon.forEach((r) => alerts.push(`???嚗?{r.customer} / ${r.orderNumber} / ?芣 ${money(r.remain)}`));
  alerts.push(...auditToday.slice(0, 3).map((a) => `隞?啣?嚗?{a.orderNumber || '-'} ${a.field || '-'} ${a.before}??{a.after}`));
  return alerts.length ? alerts : ['隞?怎??'];
}

function renderTodayAlerts(state, reportA) {
  const alerts = buildTodayAlerts(state, reportA);
  const wrap = $('financeTodayAlerts');
  if (wrap) wrap.innerHTML = alerts.map((a) => `<li>${escapeHtml(a)}</li>`).join('');
  return alerts;
}

function buildFinanceLineReminder(state, reportA) {
  const dueCritical = reportA.filter((r) => r.remain > 0 && r.age >= 30).slice(0, 5);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.age >= 7 && r.age < 30).slice(0, 5);
  const unpaid = state.payables
    .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }))
    .filter((p) => p.unpaid > 0)
    .slice(0, 5);

  const lines = [];
  lines.push(`${COMPANY_INFO.name} 財經提醒`);
  lines.push(`時間：${new Date().toLocaleString()}`);
  lines.push('');

  if (dueCritical.length) {
    lines.push('逾期應收款：30 天以上');
    dueCritical.forEach((r) => lines.push(`- ${r.customer} / ${r.orderNumber} / 未收 ${money(r.remain)} / ${r.age} 天`));
    lines.push('');
  }

  if (dueSoon.length) {
    lines.push('近期應收款：7-29 天');
    dueSoon.forEach((r) => lines.push(`- ${r.customer} / ${r.orderNumber} / 未收 ${money(r.remain)} / ${r.age} 天`));
    lines.push('');
  }

  if (unpaid.length) {
    lines.push('未付款項');
    unpaid.forEach((p) => lines.push(`- ${p.vendor || '-'} / ${p.item || '-'} / 未付 ${money(p.unpaid)}`));
    lines.push('');
  }

  if (!dueCritical.length && !dueSoon.length && !unpaid.length) {
    lines.push('目前沒有需要特別提醒的財務項目。');
  }

  return lines.join('\n');
}

async function sendFinanceLineReminder(state, reportA) {
  const response = await fetch('/api/line/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
    body: JSON.stringify({ message: buildFinanceLineReminder(state, reportA) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function getFinanceConcernCount(state, reportA) {
  const receivableDays = Number(state.settings?.receivableOverdueDays || 30);
  const payableDays = Number(state.settings?.payableWarningDays || 14);
  const overdueReceivables = reportA.filter((row) => row.remain > 0 && row.age >= receivableDays).length;
  const overduePayables = state.payables.filter((row) => {
    const unpaid = Math.max(0, Number(row.amount || 0) - Number(row.paid || 0));
    const age = row.date ? Math.floor((Date.now() - new Date(row.date).getTime()) / 86400000) : 0;
    return unpaid > 0 && age >= payableDays;
  }).length;
  return overdueReceivables + overduePayables;
}

function ensureFinanceOverview(state, reportA) {
  const main = $('financeMainScreen');
  if (!main) return;
  const heading = main.querySelector(':scope > h3');
  if (heading) heading.textContent = state.financeScreen === 'concerns' ? '?敺齒' : '鞎∠???';

  if (!$('financeOverviewIntro')) {
    const intro = document.createElement('div');
    intro.id = 'financeOverviewIntro';
    intro.className = 'finance-overview-intro';
    intro.innerHTML = `
      <div>
        <strong>????嚗?閬??楛??/strong>
        <p class="sub">擐??芷＊蝷粹?閬?憿???賊?嚗??渲???靽??典????/p>
      </div>
      <div class="finance-overview-actions">
        <button class="finance-action-card" type="button" data-finance-screen="concerns"><strong>?敺齒</strong><span>?暹????隞狡?????/span></button>
        <button class="finance-action-card" type="button" data-finance-screen="entry"><strong>?啣??嗡?甈?/strong><span>?駁????隞???/span></button>
        <button class="finance-action-card" type="button" data-finance-screen="workspace"><strong>?潛巨?銵?/strong><span>?潛巨??蝯?摰Ｘ撠董</span></button>
      </div>`;
    heading?.after(intro);

    const kpiGrid = $('kpiReceivable')?.closest('.kpi-grid');
    if (kpiGrid) {
      const concern = document.createElement('div');
      concern.className = 'kpi finance-concern-kpi';
      concern.innerHTML = '<span>?閬釣??/span><strong id="financeConcernCount">0</strong>';
      kpiGrid.append(concern);
    }
  }

  if ($('financeConcernCount')) $('financeConcernCount').textContent = String(getFinanceConcernCount(state, reportA));
}

function applyFinanceScreen(state) {
  const active = state.financeScreen || 'main';
  const main = $('financeMainScreen');
  const workspace = $('financeWorkspaceScreen');
  const entry = $('receivableForm')?.closest('.split.finance-split');
  if (entry) entry.id = 'financeEntryScreen';

  main?.classList.toggle('hidden', !['main', 'concerns'].includes(active));
  workspace?.classList.toggle('hidden', active !== 'workspace');
  entry?.classList.toggle('hidden', active !== 'entry');

  const detailNodes = [
    $('financeRecvSummary')?.closest('.kpi-grid'),
    $('sendLineReminderBtn')?.closest('.filter-row'),
    $('financeTodayAlerts')?.closest('.split.finance-split'),
    $('financeChartBars')?.closest('article.card'),
    $('financeReceivableActions')?.closest('.split.finance-split'),
  ].filter(Boolean);
  detailNodes.forEach((node) => node.classList.toggle('hidden', active !== 'concerns'));
  $('financeOverviewIntro')?.classList.toggle('finance-concerns-open', active === 'concerns');
}



export function renderFinance(state) {
  const reportA = getLinkedReceivablesData(state);
  const reportB = getReportBData(state);
  const reportC = getReportCData(state);

  const recvOutstanding = reportA.reduce((sum, r) => sum + r.remain, 0);
  const payOutstanding = state.payables.filter((p) => inRange(state, p.date)).reduce((sum, p) => sum + Math.max(0, Number(p.amount) - Number(p.paid)), 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthRow = reportC.find((r) => r.month === monthKey) || { income: 0, expense: 0, net: 0 };

  $('kpiReceivable').textContent = money(recvOutstanding);
  $('kpiPayable').textContent = money(payOutstanding);
  $('kpiIncome').textContent = money(monthRow.income);
  $('kpiExpense').textContent = money(monthRow.expense);
  $('kpiNet').textContent = money(monthRow.net);

  $('reportATbody').innerHTML = reportA.map((r) => `<tr><td>${escapeHtml(r.customer)}</td><td>${escapeHtml(r.orderNumber)}</td><td>${money(r.amount)}</td><td>${money(r.received)}</td><td>${money(r.remain)}</td><td>${escapeHtml(r.age)}</td></tr>`).join('');
  $('reportBTbody').innerHTML = reportB.map((r) => `<tr><td>${escapeHtml(r.orderNumber)}</td><td>${escapeHtml(r.customer)}</td><td>${money(r.revenue)}</td><td>${money(r.cost)}</td><td>${money(r.gross)}</td></tr>`).join('');
  $('reportCTbody').innerHTML = reportC.map((r) => `<tr><td>${escapeHtml(r.month)}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.net)}</td></tr>`).join('');

  $('reportStart').value = state.reportRange.start;
  $('reportEnd').value = state.reportRange.end;
  renderInvoicePicker(state);
  if ($('invoiceDate') && !$('invoiceDate').value) $('invoiceDate').value = getTodayText();
  renderFinanceInsights(state, reportA);
  renderTodayAlerts(state, reportA);
  renderFinanceChartAndAnalysis(reportC, reportA);
  renderFinanceQuickActions(state, reportA);
  renderMonthClose(state, reportA);

  ensureFinanceOverview(state, reportA);
  applyFinanceScreen(state);

  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.financeScreen === (state.financeScreen || 'main'));
  });
}

export function bindFinanceEvents(state, saveState, renderAll) {
  $('receivableForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const orderNumber = $('recvOrderNumber').value.trim();
    const item = {
      id: crypto.randomUUID(),
      date: $('recvDate').value || getTodayText(),
      customer: $('recvCustomer').value.trim(),
      orderNumber,
      amount: Number($('recvAmount').value || 0),
      received: Number($('recvReceived').value || 0),
    };

    const dup = state.receivables.find((r) => (r.orderNumber || '').trim() === orderNumber);
    if (dup) {
      dup.date = item.date;
      dup.customer = item.customer || dup.customer;
      dup.amount = item.amount;
      dup.received = item.received;
    } else {
      state.receivables.unshift(item);
    }

    e.target.reset();
    updateFinanceSmartHint(state);
    saveState();
    renderAll();
  });

  $('payableForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.payables.unshift({ id: crypto.randomUUID(), date: $('payDate').value, vendor: $('payVendor').value.trim(), item: $('payItem').value.trim(), amount: Number($('payAmount').value), paid: Number($('payPaid').value) });
    e.target.reset();
    saveState();
    renderAll();
  });

  $('applyReportRangeBtn')?.addEventListener('click', () => {
    state.reportRange.start = $('reportStart').value;
    state.reportRange.end = $('reportEnd').value;
    renderFinance(state);
  });

  $('exportReportABtn')?.addEventListener('click', () => {
    const rows = [['摰Ｘ', '撌亙', '?', '撌脫', '?芣', '撣喲翩(憭?']];
    getLinkedReceivablesData(state).forEach((r) => rows.push([r.customer, r.orderNumber, r.amount, r.received, r.remain, r.age]));
    downloadCsv('report-A-?撣喲翩.csv', rows);
  });
  $('exportReportBBtn')?.addEventListener('click', () => {
    const rows = [['撌亙', '摰Ｘ', '?嗅', '隡啁??(70%)', '瘥']];
    getReportBData(state).forEach((r) => rows.push([r.orderNumber, r.customer, r.revenue, r.cost, r.gross]));
    downloadCsv('report-B-瘥.csv', rows);
  });
  $('exportReportCBtn')?.addEventListener('click', () => {
    const rows = [['?遢', '?嗅', '?臬', '瘛券?']];
    getReportCData(state).forEach((r) => rows.push([r.month, r.income, r.expense, r.net]));
    downloadCsv('report-C-?嗆?.csv', rows);
  });
  $('financeCloseMonth')?.addEventListener('change', () => renderMonthClose(state, getLinkedReceivablesData(state)));
  $('exportMonthCloseBtn')?.addEventListener('click', () => exportMonthClose(state, getLinkedReceivablesData(state)));
  $('exportCustomerStatementBtn')?.addEventListener('click', () => exportCustomerStatement(state, getLinkedReceivablesData(state)));
  $('printCustomerStatementBtn')?.addEventListener('click', () => printCustomerStatement(state, getLinkedReceivablesData(state)));

  $('invoiceOrdersList')?.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-invoice-order-id]');
    if (!box) return;
    if (box.checked) selectedInvoiceOrderIds.add(box.dataset.invoiceOrderId);
    else selectedInvoiceOrderIds.delete(box.dataset.invoiceOrderId);
    applyInvoiceBuyerBySelection(state);
    renderInvoicePicker(state);
  });
  $('invoiceSelectAllBtn')?.addEventListener('click', () => {
    getInvoiceEligibleOrders(state).forEach((o) => selectedInvoiceOrderIds.add(o.id));
    applyInvoiceBuyerBySelection(state);
    renderInvoicePicker(state);
  });
  $('invoiceClearSelectBtn')?.addEventListener('click', () => {
    selectedInvoiceOrderIds.clear();
    renderInvoicePicker(state);
  });
  $('exportInvoiceBtn')?.addEventListener('click', () => openInvoiceWindow(state));
  $('sendLineReminderBtn')?.addEventListener('click', async () => {
    try {
      const result = await sendFinanceLineReminder(state, getLinkedReceivablesData(state));
      alert(`LINE 財經提醒已送出：${result.sent || 0} 個對象。`);
    } catch (err) {
      alert(`LINE 財經提醒失敗：${err.message}`);
    }
  });

  $('financeReceivableActions')?.addEventListener('click', (e) => {
    const done = e.target.closest('[data-finance-receivable-done]');
    const remove = e.target.closest('[data-finance-receivable-delete]');
    const key = done?.dataset.financeReceivableDone || remove?.dataset.financeReceivableDelete || '';
    if (!key) return;
    const item = state.receivables.find((r) => ((r.orderNumber || '').trim() || r.id) === key);
    if (done) {
      if (item) {
        item.received = Number(item.amount || 0);
      } else {
        const order = state.orders.find((o) => getOrderReceivableKey(o) === key);
        if (order) state.receivables.unshift({ id: crypto.randomUUID(), source: 'manual-close', date: getTodayText(), customer: order.billingCustomer || order.downstream || order.upstream || '-', orderNumber: key, amount: Number(order.totalPrice || 0), received: Number(order.totalPrice || 0) });
      }
    }
    if (remove) {
      if (!item) return alert('找不到這筆應收款資料，請重新整理後再試。');
      if (!window.confirm('確定要刪除這筆應收款資料嗎？')) return;
      state.receivables = state.receivables.filter((r) => r.id !== item.id);
    }
    saveState();
    renderAll();
  });

  $('financePayableActions')?.addEventListener('click', (e) => {
    const done = e.target.closest('[data-finance-payable-done]');
    const remove = e.target.closest('[data-finance-payable-delete]');
    const id = done?.dataset.financePayableDone || remove?.dataset.financePayableDelete || '';
    if (!id) return;
    const item = state.payables.find((p) => p.id === id);
    if (!item) return;
    if (done) item.paid = Number(item.amount || 0);
    if (remove) {
      if (!window.confirm('確定要刪除這筆應付款資料嗎？')) return;
      state.payables = state.payables.filter((p) => p.id !== id);
    }
    saveState();
    renderAll();
  });

  $('recvOrderNumber')?.addEventListener('input', () => autofillReceivableFromOrder(state));
  $('recvOrderNumber')?.addEventListener('blur', () => autofillReceivableFromOrder(state));
  $('recvCustomer')?.addEventListener('input', () => updateFinanceSmartHint(state));
  updateFinanceSmartHint(state);

  $('financeView')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-finance-screen]');
    if (!btn) return;
    state.financeScreen = btn.dataset.financeScreen;
    renderFinance(state);
  });
}
