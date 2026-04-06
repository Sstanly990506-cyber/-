const state = {
  user: null,
  glossOptions: JSON.parse(localStorage.getItem("glossOptions") || '["A光","B光"]'),
  customers: JSON.parse(localStorage.getItem("customers") || "[]"),
  orders: JSON.parse(localStorage.getItem("orders") || "[]"),
  audits: JSON.parse(localStorage.getItem("audits") || "[]"),
};

const views = ["loginView", "dashboardView", "ordersView", "customersView", "financeView", "auditView"];
const API_STATE_URL = "/api/state";
const $ = (id) => document.getElementById(id);

function openFinanceGate() {
  showView("financeView");
}


function persistLocalCache() {
  localStorage.setItem("glossOptions", JSON.stringify(state.glossOptions));
  localStorage.setItem("customers", JSON.stringify(state.customers));
  localStorage.setItem("orders", JSON.stringify(state.orders));
  localStorage.setItem("audits", JSON.stringify(state.audits));
}

async function loadRemoteState() {
  const res = await fetch(API_STATE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  state.glossOptions = Array.isArray(payload.glossOptions) ? payload.glossOptions : state.glossOptions;
  state.customers = Array.isArray(payload.customers) ? payload.customers : [];
  state.orders = Array.isArray(payload.orders) ? payload.orders : [];
  state.audits = Array.isArray(payload.audits) ? payload.audits : [];
  persistLocalCache();
}

async function save() {
  persistLocalCache();
  const payload = {
    glossOptions: state.glossOptions,
    customers: state.customers,
    orders: state.orders,
    audits: state.audits,
    receivables: [],
    payables: [],
    syncTick: Date.now(),
  };
  const res = await fetch(API_STATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function showView(id) {
  views.forEach((v) => $(v).classList.add("hidden"));
  $(id).classList.remove("hidden");
  if (id === "ordersView") renderOrders();
  if (id === "customersView") renderCustomers();
  if (id === "auditView") renderAudits();
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
  const upstream = $("upstreamSelect");
  const downstream = $("downstreamSelect");
  upstream.innerHTML = '<option value="">請選擇</option>';
  downstream.innerHTML = '<option value="">請選擇</option>';
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
  state.orders.forEach((order) => {
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
  state.customers.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.name}</td>
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

$("financeForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  $("financePassword").value = "";
  $("financeDialog")?.close();
  showView("financeView");
});

$("addGlossBtn").addEventListener("click", () => {
  const input = $("newGlossType");
  const val = input.value.trim();
  if (!val) return;
  if (!state.glossOptions.includes(val)) state.glossOptions.push(val);
  input.value = "";
  save()
    .then(() => renderGlossOptions())
    .catch(() => alert("儲存失敗，請確認後端 API 與資料庫連線。"));
});

$("customerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("customerName").value.trim();
  const role = $("customerRole").value;
  if (!name) return;
  state.customers.push({ id: crypto.randomUUID(), name, role, active: true });
  save()
    .then(() => {
      e.target.reset();
      renderCustomers();
    })
    .catch(() => alert("新增客戶失敗，請確認後端 API 與資料庫連線。"));
});

$("customersTbody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-toggle-customer]");
  if (!btn) return;
  const id = btn.dataset.toggleCustomer;
  const customer = state.customers.find((c) => c.id === id);
  customer.active = !customer.active;
  save()
    .then(() => renderCustomers())
    .catch(() => alert("更新客戶失敗，請確認後端 API 與資料庫連線。"));
});

$("orderForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("orderId").value || crypto.randomUUID();
  const existing = state.orders.find((o) => o.id === id);

  const payload = {
    id,
    orderNumber: $("orderNumber").value.trim(),
    orderDate: $("orderDate").value,
    upstream: $("upstreamSelect").value,
    downstream: $("downstreamSelect").value,
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

  save()
    .then(() => {
      clearOrderForm();
      renderOrders();
    })
    .catch(() => alert("儲存工單失敗，請確認後端 API 與資料庫連線。"));
});

$("ordersTbody").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-edit]");
  if (!btn) return;
  const order = state.orders.find((o) => o.id === btn.dataset.edit);
  if (!order) return;
  $("orderId").value = order.id;
  $("orderNumber").value = order.orderNumber;
  $("orderDate").value = order.orderDate;
  $("upstreamSelect").value = order.upstream;
  $("downstreamSelect").value = order.downstream;
  $("sheetCount").value = order.sheetCount;
  $("sizeLength").value = order.sizeLength;
  $("sizeWidth").value = order.sizeWidth;
  $("sizeUnit").value = order.sizeUnit;
  $("glossType").value = order.glossType;
  $("totalPrice").value = order.totalPrice;
  $("orderStatus").value = order.status;
});

$("clearOrderBtn").addEventListener("click", clearOrderForm);

// 快速進入稽核頁：在導航頁按鍵盤 A
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "a" && !$("dashboardView").classList.contains("hidden")) {
    showView("auditView");
  }
});

renderGlossOptions();
renderCustomers();
renderOrders();
showView("loginView");

loadRemoteState()
  .then(() => {
    renderGlossOptions();
    renderCustomers();
    renderOrders();
    renderAudits();
  })
  .catch(() => {
    console.warn("API 狀態讀取失敗，暫時使用 localStorage 快取。");
  });
