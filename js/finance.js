import { $, money, downloadCsv } from './shared.js';
import { getOrderReceivableKey } from './store.js';

function inRange(state, dateText) {
  const { start, end } = state.reportRange;
  if (!dateText) return true;
  if (start && dateText < start) return false;
  if (end && dateText > end) return false;
  return true;
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
  return state.orders
    .filter((o) => inRange(state, o.orderDate))
    .map((o) => {
      const revenue = Number(o.totalPrice || 0);
      const cost = Math.round(revenue * 0.7);
      return {
        orderNumber: o.orderNumber,
        customer: o.downstream || o.upstream,
        revenue,
        cost,
        gross: revenue - cost,
      };
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

export function renderFinance(state) {
  const reportA = getLinkedReceivablesData(state);
  const reportB = getReportBData(state);
  const reportC = getReportCData(state);

  const recvOutstanding = reportA.reduce((sum, r) => sum + r.remain, 0);
  const payOutstanding = state.payables
    .filter((p) => inRange(state, p.date))
    .reduce((sum, p) => sum + Math.max(0, Number(p.amount) - Number(p.paid)), 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthRow = reportC.find((r) => r.month === monthKey) || { income: 0, expense: 0, net: 0 };

  $('kpiReceivable').textContent = money(recvOutstanding);
  $('kpiPayable').textContent = money(payOutstanding);
  $('kpiIncome').textContent = money(monthRow.income);
  $('kpiExpense').textContent = money(monthRow.expense);
  $('kpiNet').textContent = money(monthRow.net);

  const aBody = $('reportATbody');
  aBody.innerHTML = '';
  reportA.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.customer}</td><td>${r.orderNumber}</td><td>${money(r.amount)}</td><td>${money(r.received)}</td><td>${money(r.remain)}</td><td>${r.age}</td>`;
    aBody.append(tr);
  });

  const bBody = $('reportBTbody');
  bBody.innerHTML = '';
  reportB.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.orderNumber}</td><td>${r.customer}</td><td>${money(r.revenue)}</td><td>${money(r.cost)}</td><td>${money(r.gross)}</td>`;
    bBody.append(tr);
  });

  const cBody = $('reportCTbody');
  cBody.innerHTML = '';
  reportC.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.month}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.net)}</td>`;
    cBody.append(tr);
  });

  $('reportStart').value = state.reportRange.start;
  $('reportEnd').value = state.reportRange.end;

  const isMain = state.financeScreen === 'main';
  $('financeMainScreen').classList.toggle('hidden', !isMain);
  $('financeReportsScreen').classList.toggle('hidden', isMain);
  $('financeReportsTables').classList.toggle('hidden', isMain);
  $('financeReportCWrap').classList.toggle('hidden', isMain);
  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.financeScreen === state.financeScreen);
  });
}

export function bindFinanceEvents(state, saveState, renderAll) {
  $('receivableForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.receivables.unshift({
      id: crypto.randomUUID(),
      date: $('recvDate').value,
      customer: $('recvCustomer').value.trim(),
      orderNumber: $('recvOrderNumber').value.trim(),
      amount: Number($('recvAmount').value),
      received: Number($('recvReceived').value),
    });
    e.target.reset();
    saveState();
    renderAll();
  });

  $('payableForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.payables.unshift({
      id: crypto.randomUUID(),
      date: $('payDate').value,
      vendor: $('payVendor').value.trim(),
      item: $('payItem').value.trim(),
      amount: Number($('payAmount').value),
      paid: Number($('payPaid').value),
    });
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

  document.querySelectorAll('[data-finance-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.financeScreen = btn.dataset.financeScreen;
      renderFinance(state);
    });
  });
}
