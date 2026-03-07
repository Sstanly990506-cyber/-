import { $, money, downloadCsv, getTodayText } from './shared.js';
import { getOrderReceivableKey } from './store.js';

const selectedInvoiceOrderIds = new Set();

function inRange(state, dateText) {
  const { start, end } = state.reportRange;
  if (!dateText) return true;
  if (start && dateText < start) return false;
  if (end && dateText > end) return false;
  return true;
}

function getInvoiceEligibleOrders(state) {
  return state.orders.filter((o) => ['已完成', '已送出'].includes(o.status));
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

function renderInvoiceMeta(meta) {
  return `<div class="meta">
    <div>發票日期：${meta.date || '-'}</div>
    <div>發票號碼：${meta.number || '-'}</div>
    <div>買方名稱：${meta.buyerName || '-'}</div>
    <div>買方統編：${meta.buyerTaxId || '-'}</div>
    <div style="grid-column:1 / -1;">買方地址：${meta.buyerAddress || '-'}</div>
    <div style="grid-column:1 / -1;">備註：${meta.note || '-'}</div>
  </div>`;
}

function renderInvoicePicker(state) {
  const wrap = $('invoiceOrdersList');
  const summary = $('invoiceSelectSummary');
  if (!wrap || !summary) return;
  wrap.innerHTML = '';

  const orders = getInvoiceEligibleOrders(state);
  if (!orders.length) {
    wrap.innerHTML = '<p class="sub">目前沒有可開立發票工單。</p>';
    summary.textContent = '已選 0 筆，合計 0 元';
    return;
  }

  orders.forEach((order) => {
    const row = document.createElement('label');
    row.className = 'invoice-order-item';
    row.innerHTML = `
      <input type="checkbox" data-invoice-order-id="${order.id}" ${selectedInvoiceOrderIds.has(order.id) ? 'checked' : ''} />
      <strong>${order.orderNumber || '未填工單號'}</strong>
      <span>${order.downstream || order.upstream || '-'}</span>
      <span>${order.orderDate || '-'}</span>
      <span>NT$ ${money(order.totalPrice || 0)}</span>`;
    wrap.append(row);
  });

  const selected = getSelectedInvoiceOrders(state);
  const total = selected.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  summary.textContent = `已選 ${selected.length} 筆，合計 ${money(total)} 元`;
}

function openInvoiceWindow(state) {
  const selected = getSelectedInvoiceOrders(state);
  if (!selected.length) {
    alert('請至少選擇一筆工單再匯出發票');
    return;
  }
  const meta = getInvoiceMeta();
  const total = selected.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  const rows = selected
    .map((o, i) => `<tr><td>${i + 1}</td><td>${o.orderNumber || '-'}</td><td>${o.downstream || o.upstream || '-'}</td><td>${o.orderDate || '-'}</td><td style="text-align:right;">${money(o.totalPrice || 0)}</td></tr>`)
    .join('');

  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8" /><title>發票匯出</title>
  <style>body{font-family:"Noto Sans TC",sans-serif;padding:16px}.copy{border:2px solid #555;padding:12px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #777;padding:6px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}.sum{font-weight:700;text-align:right}</style></head><body>
  <div class="copy"><h2>電子發票（白聯）</h2>${renderInvoiceMeta(meta)}<table><thead><tr><th>#</th><th>工單</th><th>客戶</th><th>日期</th><th>金額</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">合計：NT$ ${money(total)}</div></div>
  <div class="copy"><h2>電子發票（粉紅聯）</h2>${renderInvoiceMeta(meta)}<table><thead><tr><th>#</th><th>工單</th><th>客戶</th><th>日期</th><th>金額</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">合計：NT$ ${money(total)}</div></div>
  <script>window.print();</script></body></html>`;

  const win = window.open('', '_blank', 'width=980,height=760');
  if (!win) return alert('請允許彈出視窗');
  win.document.write(html);
  win.document.close();
}

export function getLinkedReceivablesData(state) {
  const orderMap = new Map();

  state.orders
    .filter((o) => ['已完成', '已送出'].includes(o.status))
    .filter((o) => inRange(state, o.orderDate))
    .forEach((o) => {
      const key = getOrderReceivableKey(o);
      orderMap.set(key, {
        key,
        date: o.orderDate || '',
        customer: o.downstream || o.upstream || '-',
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
        orderNumber: item.orderNumber || '(未填工單)',
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
    return { orderNumber: o.orderNumber, customer: o.downstream || o.upstream, revenue, cost, gross: revenue - cost };
  });
}

function getReportCData(state) {
  const map = new Map();
  state.receivables.filter((r) => inRange(state, r.date)).forEach((r) => {
    const month = (r.date || '').slice(0, 7) || '未填日期';
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).income += Number(r.received || 0);
  });
  state.payables.filter((p) => inRange(state, p.date)).forEach((p) => {
    const month = (p.date || '').slice(0, 7) || '未填日期';
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).expense += Number(p.paid || 0);
  });
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month)).map((m) => ({ ...m, net: m.income - m.expense }));
}

function renderFinanceInsights(state, reportA) {
  const received = reportA.reduce((sum, r) => sum + Number(r.received || 0), 0);
  const unreceived = reportA.reduce((sum, r) => sum + Number(r.remain || 0), 0);
  $('financeRecvSummary').textContent = `${money(received)} / ${money(unreceived)}`;

  const recent = [...state.audits].slice(0, 5);
  const recentWrap = $('financeRecentChanges');
  recentWrap.innerHTML = recent.length
    ? recent.map((a) => `<li>${a.changedAt || '-'}｜${a.orderNumber || '-'}｜${a.field || '-'}：${a.before} → ${a.after}</li>`).join('')
    : '<li>目前沒有異動紀錄</li>';

  const dueLimit = new Date();
  dueLimit.setDate(dueLimit.getDate() + 7);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.date && new Date(r.date) <= dueLimit).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  $('financeDueSoonCount').textContent = String(dueSoon.length);
  const dueWrap = $('financeDueSoonList');
  dueWrap.innerHTML = dueSoon.length
    ? dueSoon.map((r) => `<li>${r.date}｜${r.customer}｜${r.orderNumber}｜未收 ${money(r.remain)}</li>`).join('')
    : '<li>7 日內無快到期帳款</li>';
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

  $('reportATbody').innerHTML = reportA.map((r) => `<tr><td>${r.customer}</td><td>${r.orderNumber}</td><td>${money(r.amount)}</td><td>${money(r.received)}</td><td>${money(r.remain)}</td><td>${r.age}</td></tr>`).join('');
  $('reportBTbody').innerHTML = reportB.map((r) => `<tr><td>${r.orderNumber}</td><td>${r.customer}</td><td>${money(r.revenue)}</td><td>${money(r.cost)}</td><td>${money(r.gross)}</td></tr>`).join('');
  $('reportCTbody').innerHTML = reportC.map((r) => `<tr><td>${r.month}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.net)}</td></tr>`).join('');

  $('reportStart').value = state.reportRange.start;
  $('reportEnd').value = state.reportRange.end;
  renderInvoicePicker(state);
  if ($('invoiceDate') && !$('invoiceDate').value) $('invoiceDate').value = getTodayText();
  renderFinanceInsights(state, reportA);

  const isMain = state.financeScreen === 'main';
  $('financeMainScreen').classList.toggle('hidden', !isMain);
  $('financeWorkspaceScreen').classList.toggle('hidden', isMain);

  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.financeScreen === state.financeScreen);
  });
}

export function bindFinanceEvents(state, saveState, renderAll) {
  $('receivableForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.receivables.unshift({ id: crypto.randomUUID(), date: $('recvDate').value, customer: $('recvCustomer').value.trim(), orderNumber: $('recvOrderNumber').value.trim(), amount: Number($('recvAmount').value), received: Number($('recvReceived').value) });
    e.target.reset();
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
    const rows = [['客戶', '工單', '應收', '已收', '未收', '帳齡(天)']];
    getLinkedReceivablesData(state).forEach((r) => rows.push([r.customer, r.orderNumber, r.amount, r.received, r.remain, r.age]));
    downloadCsv('report-A-應收帳齡.csv', rows);
  });
  $('exportReportBBtn')?.addEventListener('click', () => {
    const rows = [['工單', '客戶', '收入', '估算成本(70%)', '毛利']];
    getReportBData(state).forEach((r) => rows.push([r.orderNumber, r.customer, r.revenue, r.cost, r.gross]));
    downloadCsv('report-B-毛利.csv', rows);
  });
  $('exportReportCBtn')?.addEventListener('click', () => {
    const rows = [['月份', '收入', '支出', '淨額']];
    getReportCData(state).forEach((r) => rows.push([r.month, r.income, r.expense, r.net]));
    downloadCsv('report-C-收支月報.csv', rows);
  });

  $('invoiceOrdersList')?.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-invoice-order-id]');
    if (!box) return;
    if (box.checked) selectedInvoiceOrderIds.add(box.dataset.invoiceOrderId);
    else selectedInvoiceOrderIds.delete(box.dataset.invoiceOrderId);
    renderInvoicePicker(state);
  });
  $('invoiceSelectAllBtn')?.addEventListener('click', () => {
    getInvoiceEligibleOrders(state).forEach((o) => selectedInvoiceOrderIds.add(o.id));
    renderInvoicePicker(state);
  });
  $('invoiceClearSelectBtn')?.addEventListener('click', () => {
    selectedInvoiceOrderIds.clear();
    renderInvoicePicker(state);
  });
  $('exportInvoiceBtn')?.addEventListener('click', () => openInvoiceWindow(state));

  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.financeScreen = btn.dataset.financeScreen;
      renderFinance(state);
    });
  });
}
