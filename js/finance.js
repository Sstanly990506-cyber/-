import { $, COMPANY_INFO, money, downloadCsv, getTodayText } from './shared.js';
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
    hint.textContent = '智能建議：輸入工單編號可自動帶入客戶與金額。';
    return;
  }
  hint.textContent = `智能建議：已找到工單 ${order.orderNumber || '-'}，可快速建立應收。`;
}

function autofillReceivableFromOrder(state) {
  const order = findOrderByNumber(state, $('recvOrderNumber')?.value || '');
  if (!order) return updateFinanceSmartHint(state);
  if ($('recvCustomer') && !$('recvCustomer').value.trim()) $('recvCustomer').value = order.downstream || order.upstream || '';
  if ($('recvAmount') && Number($('recvAmount').value || 0) <= 0) $('recvAmount').value = String(Number(order.totalPrice || 0));
  if ($('recvDate') && !$('recvDate').value) $('recvDate').value = order.orderDate || getTodayText();
  updateFinanceSmartHint(state);
}

function applyInvoiceBuyerBySelection(state) {
  const selected = getSelectedInvoiceOrders(state);
  if (!selected.length) return;
  const customerNames = selected.map((o) => o.downstream || o.upstream || '').filter(Boolean);
  if (!customerNames.length) return;
  const count = new Map();
  customerNames.forEach((n) => count.set(n, (count.get(n) || 0) + 1));
  const [bestName] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const customer = state.customers.find((c) => (c.name || '').trim() === bestName);
  if ($('invoiceBuyerName') && !$('invoiceBuyerName').value.trim()) $('invoiceBuyerName').value = bestName;
  if ($('invoiceBuyerAddress') && customer?.address && !$('invoiceBuyerAddress').value.trim()) $('invoiceBuyerAddress').value = customer.address;
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
  <div class="copy"><h2>${COMPANY_INFO.name} 電子發票</h2><p>${COMPANY_INFO.address}</p>${renderInvoiceMeta(meta)}<table><thead><tr><th>#</th><th>工單</th><th>客戶</th><th>日期</th><th>金額</th></tr></thead><tbody>${rows}</tbody></table><div class="sum">合計：NT$ ${money(total)}</div></div>
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
      return `<div class="chart-bar-row"><span>${row.month}</span><div class="chart-bar-track"><div class="chart-bar-fill ${net < 0 ? 'neg' : ''}" style="width:${width}%"></div></div><strong>${money(net)}</strong></div>`;
    }).join('')
    : '<p class="sub">目前沒有月報資料</p>';

  const totalRecv = reportA.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalReceived = reportA.reduce((sum, row) => sum + Number(row.received || 0), 0);
  const collectionRate = totalRecv > 0 ? (totalReceived / totalRecv) * 100 : 0;
  const avgNet = recent.length ? recent.reduce((sum, row) => sum + Number(row.net || 0), 0) / recent.length : 0;
  $('financeCollectionRate').textContent = `${collectionRate.toFixed(1)}%`;
  $('financeAvgNet6m').textContent = money(Math.round(avgNet));

  const insights = [];
  if (avgNet < 0) insights.push('近 6 月平均淨額為負，建議優先檢視高成本工單與應付付款節奏。');
  if (collectionRate < 70) insights.push(`收款率 ${collectionRate.toFixed(1)}% 偏低，建議啟動催收流程。`);
  const topOverdue = [...reportA].filter((r) => r.remain > 0).sort((a, b) => b.remain - a.remain).slice(0, 3);
  if (topOverdue.length) insights.push(`未收風險前 3 名：${topOverdue.map((r) => `${r.customer}/${money(r.remain)}`).join('、')}`);
  analysis.innerHTML = (insights.length ? insights : ['財務結構穩定，請持續追蹤帳齡與月報。']).map((line) => `<li>${line}</li>`).join('');
}


function buildTodayAlerts(state, reportA) {
  const today = new Date().toISOString().slice(0, 10);
  const unpaidToday = state.payables.filter((p) => (p.date || '').slice(0, 10) === today && Number(p.amount || 0) > Number(p.paid || 0));
  const auditToday = state.audits.filter((a) => String(a.changedAt || '').includes(today));
  const dueLimit = new Date();
  dueLimit.setDate(dueLimit.getDate() + 1);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.date && new Date(r.date) <= dueLimit);

  const alerts = [];
  unpaidToday.forEach((p) => alerts.push(`應付未付：${p.vendor || '-'} / ${p.item || '-'} / 未付 ${money(Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)))}`));
  dueSoon.forEach((r) => alerts.push(`應收提醒：${r.customer} / ${r.orderNumber} / 未收 ${money(r.remain)}`));
  alerts.push(...auditToday.slice(0, 3).map((a) => `今日異動：${a.orderNumber || '-'} ${a.field || '-'} ${a.before}→${a.after}`));
  return alerts.length ? alerts : ['今日暫無提醒'];
}

function renderTodayAlerts(state, reportA) {
  const alerts = buildTodayAlerts(state, reportA);
  const wrap = $('financeTodayAlerts');
  if (wrap) wrap.innerHTML = alerts.map((a) => `<li>${a}</li>`).join('');
  return alerts;
}

function openLineReminder(state, reportA) {
  const dueCritical = reportA.filter((r) => r.remain > 0 && r.age >= 30).slice(0, 5);
  const dueSoon = reportA.filter((r) => r.remain > 0 && r.age >= 7 && r.age < 30).slice(0, 5);
  const unpaid = state.payables
    .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }))
    .filter((p) => p.unpaid > 0)
    .slice(0, 5);

  const lines = [];
  lines.push(`【${COMPANY_INFO.name} 財經智能提醒】`);
  lines.push(`時間：${new Date().toLocaleString()}`);
  lines.push('');

  if (dueCritical.length) {
    lines.push('🔴 應收逾期（>=30天）');
    dueCritical.forEach((r) => lines.push(`- ${r.customer} / ${r.orderNumber} / 未收 ${money(r.remain)} / 帳齡 ${r.age} 天`));
    lines.push('');
  }

  if (dueSoon.length) {
    lines.push('🟠 應收警示（7~29天）');
    dueSoon.forEach((r) => lines.push(`- ${r.customer} / ${r.orderNumber} / 未收 ${money(r.remain)} / 帳齡 ${r.age} 天`));
    lines.push('');
  }

  if (unpaid.length) {
    lines.push('🔵 應付待付款');
    unpaid.forEach((p) => lines.push(`- ${p.vendor || '-'} / ${p.item || '-'} / 未付 ${money(p.unpaid)}`));
    lines.push('');
  }

  if (!dueCritical.length && !dueSoon.length && !unpaid.length) {
    lines.push('✅ 今日財經狀態正常，無需特別提醒。');
  }

  const url = `https://line.me/R/msg/text/?${encodeURIComponent(lines.join('\n'))}`;
  window.open(url, '_blank', 'noopener');
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
  renderTodayAlerts(state, reportA);
  renderFinanceChartAndAnalysis(reportC, reportA);

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
  $('sendLineReminderBtn')?.addEventListener('click', () => openLineReminder(state, getLinkedReceivablesData(state)));

  $('recvOrderNumber')?.addEventListener('input', () => autofillReceivableFromOrder(state));
  $('recvOrderNumber')?.addEventListener('blur', () => autofillReceivableFromOrder(state));
  $('recvCustomer')?.addEventListener('input', () => updateFinanceSmartHint(state));
  updateFinanceSmartHint(state);

  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.financeScreen = btn.dataset.financeScreen;
      renderFinance(state);
    });
  });
}
