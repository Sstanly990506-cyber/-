const state = {
  user: null,
  financePassword: "finance123",
  glossOptions: JSON.parse(localStorage.getItem("glossOptions") || '["A光","B光"]'),
  customers: JSON.parse(localStorage.getItem("customers") || "[]"),
  orders: JSON.parse(localStorage.getItem("orders") || "[]"),
  audits: JSON.parse(localStorage.getItem("audits") || "[]"),
  orderStatusFilter: "全部",
  orderScreen: "list",
};

const views = ["loginView", "dashboardView", "ordersView", "customersView", "financeView", "auditView"];
const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = ["glossOptions", "customers", "orders", "audits"];
let lastSyncAt = 0;

function loadStateFromStorage() {
  state.glossOptions = JSON.parse(localStorage.getItem("glossOptions") || '["A光","B光"]');
  state.customers = JSON.parse(localStorage.getItem("customers") || "[]");
  state.orders = JSON.parse(localStorage.getItem("orders") || "[]");
  state.audits = JSON.parse(localStorage.getItem("audits") || "[]");
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
}

function syncFromOtherClient() {
  loadStateFromStorage();
  refreshAllViews();
  lastSyncAt = Date.now();
  markSynced("已收到最新資料");
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
  localStorage.setItem("glossOptions", JSON.stringify(state.glossOptions));
  localStorage.setItem("customers", JSON.stringify(state.customers));
  localStorage.setItem("orders", JSON.stringify(state.orders));
  localStorage.setItem("audits", JSON.stringify(state.audits));
  localStorage.setItem("syncTick", String(Date.now()));
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

renderGlossOptions();
renderCustomers();
renderOrders();
renderOrderScreen();
showView("loginView");
