const state = {
  user: null,
  financePassword: "finance123",
  glossOptions: JSON.parse(localStorage.getItem("glossOptions") || '["A光","B光"]'),
  customers: JSON.parse(localStorage.getItem("customers") || "[]"),
  orders: JSON.parse(localStorage.getItem("orders") || "[]"),
  audits: JSON.parse(localStorage.getItem("audits") || "[]"),
  receivables: JSON.parse(localStorage.getItem("receivables") || "[]"),
  payables: JSON.parse(localStorage.getItem("payables") || "[]"),
  reportRange: { start: "", end: "" },
  orderStatusFilter: "全部",
  orderScreen: "list",
};

const views = ["loginView", "dashboardView", "ordersView", "customersView", "financeView", "auditView"];
const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = ["glossOptions", "customers", "orders", "audits", "receivables", "payables"];
const APP_BUILD = "2026-02-27-sync-check-1";
let lastSyncAt = 0;

function setBuildVersion() {
  const el = $("buildVersion");
  if (!el) return;
  el.textContent = `版本：${APP_BUILD}`;
}

function formatTs(ts) {
  if (!ts) return "尚未同步";
  return new Date(ts).toLocaleTimeString();
}

function updateSyncDetail(source, ts = Date.now()) {
  const detail = $("syncDetail");
  if (!detail) return;
  detail.textContent = `最後更新：${formatTs(ts)}（${source}）`;
}

function loadStateFromStorage() {
  state.glossOptions = JSON.parse(localStorage.getItem("glossOptions") || '["A光","B光"]');
  state.customers = JSON.parse(localStorage.getItem("customers") || "[]");
  state.orders = JSON.parse(localStorage.getItem("orders") || "[]");
  state.audits = JSON.parse(localStorage.getItem("audits") || "[]");
  state.receivables = JSON.parse(localStorage.getItem("receivables") || "[]");
  state.payables = JSON.parse(localStorage.getItem("payables") || "[]");
}

function markSynced(message = "已同步") {
  const badge = $("syncBadge");
  if (!badge) return;
  badge.textContent = message;
  badge.classList.add("ok");
  clearTimeout(markSynced._timer);
  markSynced._timer = setTimeout(() => {
    badge.textContent = "同步中";
    badge.classList.remove("ok");
  }, 1200);
}

function refreshAllViews() {
  renderGlossOptions();
  renderCustomers();
  renderOrders();
  renderAudits();
  renderFinance();
}

function syncFromOtherClient() {
  loadStateFromStorage();
  refreshAllViews();
  lastSyncAt = Number(localStorage.getItem("syncTick") || Date.now());
  markSynced("已收到最新資料");
  updateSyncDetail("跨分頁同步", lastSyncAt);
}

function openFinanceGate() {
  const dialog = $("financeDialog");
  if (dialog && typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }

  const input = window.prompt("請輸入財經系統密碼");
  if (input === null) return;
  if (input !== state.financePassword) {
    alert("密碼錯誤");
    return;
  }
  showView("financeView");
}

function save() {
  const now = Date.now();
  localStorage.setItem("glossOptions", JSON.stringify(state.glossOptions));
  localStorage.setItem("customers", JSON.stringify(state.customers));
  localStorage.setItem("orders", JSON.stringify(state.orders));
  localStorage.setItem("audits", JSON.stringify(state.audits));
  localStorage.setItem("receivables", JSON.stringify(state.receivables));
  localStorage.setItem("payables", JSON.stringify(state.payables));
  localStorage.setItem("syncTick", String(now));
  lastSyncAt = now;
  markSynced("已儲存");
  updateSyncDetail("本機儲存", now);
}

function showView(id) {
  views.forEach((v) => $(v).classList.add("hidden"));
  $(id).classList.remove("hidden");
  if (id === "ordersView") {
    state.orderScreen = "list";
    renderOrderScreen();
    renderOrders();
  }
  if (id === "customersView") renderCustomers();
  if (id === "auditView") renderAudits();
  if (id === "financeView") renderFinance();
}

function renderOrderScreen() {
  const listScreen = $("ordersListScreen");
  const formScreen = $("ordersFormScreen");
  const isList = state.orderScreen === "list";
  listScreen.classList.toggle("hidden", !isList);
  formScreen.classList.toggle("hidden", isList);

  document.querySelectorAll("[data-order-screen]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.orderScreen === state.orderScreen);
  });
}

function renderGlossOptions() {
  const select = $("glossType");
  select.innerHTML = "";
  state.glossOptions.forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    select.append(o);
  });
}

function renderCustomerOptions() {
  const upstream = $("upstreamOptions");
  const downstream = $("downstreamOptions");
  upstream.innerHTML = "";
  downstream.innerHTML = "";
  const active = state.customers.filter((c) => c.active !== false);

  active
    .filter((c) => c.role === "上游" || c.role === "兩者")
    .forEach((c) => upstream.append(new Option(c.name, c.name)));
  active
    .filter((c) => c.role === "下游" || c.role === "兩者")
    .forEach((c) => downstream.append(new Option(c.name, c.name)));
}

function renderOrders() {
  renderGlossOptions();
  renderCustomerOptions();
  const body = $("ordersTbody");
  body.innerHTML = "";

  const filteredOrders = state.orders.filter((order) =>
    state.orderStatusFilter === "全部" ? true : order.status === state.orderStatusFilter,
  );

  filteredOrders.forEach((order) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${order.orderNumber}</td>
      <td>${order.orderDate}</td>
      <td>${order.upstream}</td>
      <td>${order.downstream}</td>
      <td>${Number(order.totalPrice).toLocaleString()}</td>
      <td>${order.status}</td>
      <td><button class="btn" data-edit="${order.id}">編輯</button></td>`;
    body.append(tr);
  });
}

function renderCustomers() {
  const body = $("customersTbody");
  body.innerHTML = "";
  const keyword = $("customerSearch").value.trim().toLowerCase();

  state.customers
    .filter((c) => {
      if (!keyword) return true;
      return [c.name, c.phone || "", c.address || ""].join(" ").toLowerCase().includes(keyword);
    })
    .forEach((c) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.phone || "-"}</td>
      <td>${c.address || "-"}</td>
      <td>${c.role}</td>
      <td><span class="tag ${c.active === false ? "off" : ""}">${c.active === false ? "停用" : "啟用"}</span></td>
      <td><button class="btn" data-toggle-customer="${c.id}">${c.active === false ? "啟用" : "停用"}</button></td>
    `;
      body.append(tr);
    });
  renderCustomerOptions();
}

function renderAudits() {
  const body = $("auditTbody");
  body.innerHTML = "";
  state.audits.forEach((a) => {
    const tr = document.createElement("tr");
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

function money(n) {
  return Number(n || 0).toLocaleString();
}

function inRange(dateText) {
  const { start, end } = state.reportRange;
  if (!dateText) return true;
  if (start && dateText < start) return false;
  if (end && dateText > end) return false;
  return true;
}

function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function downloadCsv(filename, rows) {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function getReportAData() {
  return state.receivables
    .filter((item) => inRange(item.date))
    .map((item) => {
      const remain = Math.max(0, Number(item.amount) - Number(item.received));
      const age = item.date ? Math.floor((Date.now() - new Date(item.date).getTime()) / 86400000) : 0;
      return { ...item, remain, age };
    });
}

function getReportBData() {
  return state.orders
    .filter((o) => inRange(o.orderDate))
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

function getReportCData() {
  const map = new Map();
  state.receivables.filter((r) => inRange(r.date)).forEach((r) => {
    const month = (r.date || "").slice(0, 7) || "未填日期";
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).income += Number(r.received || 0);
  });
  state.payables.filter((p) => inRange(p.date)).forEach((p) => {
    const month = (p.date || "").slice(0, 7) || "未填日期";
    if (!map.has(month)) map.set(month, { month, income: 0, expense: 0 });
    map.get(month).expense += Number(p.paid || 0);
  });
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month)).map((m) => ({ ...m, net: m.income - m.expense }));
}

function renderFinance() {
  const reportA = getReportAData();
  const reportB = getReportBData();
  const reportC = getReportCData();

  const recvOutstanding = reportA.reduce((sum, r) => sum + r.remain, 0);
  const payOutstanding = state.payables
    .filter((p) => inRange(p.date))
    .reduce((sum, p) => sum + Math.max(0, Number(p.amount) - Number(p.paid)), 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthRow = reportC.find((r) => r.month === monthKey) || { income: 0, expense: 0, net: 0 };

  $("kpiReceivable").textContent = money(recvOutstanding);
  $("kpiPayable").textContent = money(payOutstanding);
  $("kpiIncome").textContent = money(monthRow.income);
  $("kpiExpense").textContent = money(monthRow.expense);
  $("kpiNet").textContent = money(monthRow.net);

  const aBody = $("reportATbody");
  aBody.innerHTML = "";
  reportA.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.customer}</td><td>${r.orderNumber}</td><td>${money(r.amount)}</td><td>${money(r.received)}</td><td>${money(r.remain)}</td><td>${r.age}</td>`;
    aBody.append(tr);
  });

  const bBody = $("reportBTbody");
  bBody.innerHTML = "";
  reportB.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.orderNumber}</td><td>${r.customer}</td><td>${money(r.revenue)}</td><td>${money(r.cost)}</td><td>${money(r.gross)}</td>`;
    bBody.append(tr);
  });

  const cBody = $("reportCTbody");
  cBody.innerHTML = "";
  reportC.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.month}</td><td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.net)}</td>`;
    cBody.append(tr);
  });

  $("reportStart").value = state.reportRange.start;
  $("reportEnd").value = state.reportRange.end;
}

function clearOrderForm() {
  $("orderForm").reset();
  $("orderId").value = "";
}

$("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.user = $("username").value.trim();
  $("welcomeText").textContent = `你好，${state.user}`;
  showView("dashboardView");
});

$("logoutBtn").addEventListener("click", () => {
  state.user = null;
  showView("loginView");
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView("dashboardView"));
});

document.querySelectorAll(".nav-card").forEach((card) => {
  card.addEventListener("click", () => {
    const target = card.dataset.target;
    if (target === "financeView") {
      openFinanceGate();
      return;
    }
    showView(target);
  });
});

$("financeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("financePassword").value;
  if (value !== state.financePassword) {
    alert("密碼錯誤");
    return;
  }
  $("financePassword").value = "";
  $("financeDialog").close();
  showView("financeView");
});

$("addGlossBtn").addEventListener("click", () => {
  const input = $("newGlossType");
  const val = input.value.trim();
  if (!val) return;
  if (!state.glossOptions.includes(val)) state.glossOptions.push(val);
  input.value = "";
  save();
  renderGlossOptions();
});

$("customerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("customerName").value.trim();
  const role = $("customerRole").value;
  const phone = $("customerPhone").value.trim();
  const address = $("customerAddress").value.trim();
  if (!name) return;
  state.customers.push({ id: crypto.randomUUID(), name, role, phone, address, active: true });
  save();
  e.target.reset();
  renderCustomers();
});

$("customerSearch").addEventListener("input", renderCustomers);

$("customersTbody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-toggle-customer]");
  if (!btn) return;
  const id = btn.dataset.toggleCustomer;
  const customer = state.customers.find((c) => c.id === id);
  customer.active = !customer.active;
  save();
  renderCustomers();
});

$("orderForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("orderId").value || crypto.randomUUID();
  const existing = state.orders.find((o) => o.id === id);

  const payload = {
    id,
    orderNumber: $("orderNumber").value.trim(),
    orderDate: $("orderDate").value,
    upstream: $("upstreamInput").value.trim(),
    downstream: $("downstreamInput").value.trim(),
    sheetCount: Number($("sheetCount").value),
    sizeLength: Number($("sizeLength").value),
    sizeWidth: Number($("sizeWidth").value),
    sizeUnit: $("sizeUnit").value,
    glossType: $("glossType").value,
    totalPrice: Number($("totalPrice").value),
    status: $("orderStatus").value,
  };

  if (existing) {
    if (existing.totalPrice !== payload.totalPrice) {
      state.audits.unshift({
        orderNumber: payload.orderNumber,
        field: "總價",
        before: existing.totalPrice,
        after: payload.totalPrice,
        changedAt: new Date().toLocaleString(),
        user: state.user,
        device: `${location.hostname || "localhost"} / ${navigator.userAgent.slice(0, 40)}...`,
      });
    }
    Object.assign(existing, payload);
  } else {
    state.orders.unshift(payload);
  }

  save();
  clearOrderForm();
  state.orderScreen = "list";
  renderOrderScreen();
  renderOrders();
});

$("ordersTbody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-edit]");
  if (!btn) return;
  const order = state.orders.find((o) => o.id === btn.dataset.edit);
  if (!order) return;
  $("orderId").value = order.id;
  $("orderNumber").value = order.orderNumber;
  $("orderDate").value = order.orderDate;
  $("upstreamInput").value = order.upstream;
  $("downstreamInput").value = order.downstream;
  $("sheetCount").value = order.sheetCount;
  $("sizeLength").value = order.sizeLength;
  $("sizeWidth").value = order.sizeWidth;
  $("sizeUnit").value = order.sizeUnit;
  $("glossType").value = order.glossType;
  $("totalPrice").value = order.totalPrice;
  $("orderStatus").value = order.status;
  state.orderScreen = "form";
  renderOrderScreen();
});

$("clearOrderBtn").addEventListener("click", clearOrderForm);

document.querySelectorAll("[data-order-screen]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.orderScreen = btn.dataset.orderScreen;
    renderOrderScreen();
  });
});

document.querySelectorAll("[data-status-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.orderStatusFilter = btn.dataset.statusFilter;
    document.querySelectorAll("[data-status-filter]").forEach((filterBtn) => {
      filterBtn.classList.toggle("active", filterBtn.dataset.statusFilter === state.orderStatusFilter);
    });
    renderOrders();
  });
});

// 快速進入稽核頁：在導航頁按鍵盤 A
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "a" && !$("dashboardView").classList.contains("hidden")) {
    showView("auditView");
  }
});


$("receivableForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.receivables.unshift({
    id: crypto.randomUUID(),
    date: $("recvDate").value,
    customer: $("recvCustomer").value.trim(),
    orderNumber: $("recvOrderNumber").value.trim(),
    amount: Number($("recvAmount").value),
    received: Number($("recvReceived").value),
  });
  e.target.reset();
  save();
  renderFinance();
});

$("payableForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.payables.unshift({
    id: crypto.randomUUID(),
    date: $("payDate").value,
    vendor: $("payVendor").value.trim(),
    item: $("payItem").value.trim(),
    amount: Number($("payAmount").value),
    paid: Number($("payPaid").value),
  });
  e.target.reset();
  save();
  renderFinance();
});

$("applyReportRangeBtn").addEventListener("click", () => {
  state.reportRange.start = $("reportStart").value;
  state.reportRange.end = $("reportEnd").value;
  renderFinance();
});

$("exportReportABtn").addEventListener("click", () => {
  const rows = [["客戶", "工單", "應收", "已收", "未收", "帳齡(天)"]];
  getReportAData().forEach((r) => rows.push([r.customer, r.orderNumber, r.amount, r.received, r.remain, r.age]));
  downloadCsv("report-A-應收帳齡.csv", rows);
});

$("exportReportBBtn").addEventListener("click", () => {
  const rows = [["工單", "客戶", "收入", "估算成本(70%)", "毛利"]];
  getReportBData().forEach((r) => rows.push([r.orderNumber, r.customer, r.revenue, r.cost, r.gross]));
  downloadCsv("report-B-毛利.csv", rows);
});

$("exportReportCBtn").addEventListener("click", () => {
  const rows = [["月份", "收入", "支出", "淨額"]];
  getReportCData().forEach((r) => rows.push([r.month, r.income, r.expense, r.net]));
  downloadCsv("report-C-收支月報.csv", rows);
});

window.addEventListener("storage", (e) => {
  if (STORAGE_KEYS.includes(e.key) || e.key === "syncTick") {
    syncFromOtherClient();
  }
});

setInterval(() => {
  const tick = Number(localStorage.getItem("syncTick") || 0);
  if (tick > lastSyncAt) {
    syncFromOtherClient();
  }
}, 1500);

setBuildVersion();
updateSyncDetail("頁面載入", Number(localStorage.getItem("syncTick") || 0));
renderGlossOptions();
renderCustomers();
renderOrders();
renderOrderScreen();
showView("loginView");
