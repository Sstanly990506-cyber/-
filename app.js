const refs = {
  loginView: document.querySelector('#login-view'),
  dashboardView: document.querySelector('#dashboard-view'),
  loginForm: document.querySelector('#login-form'),
  loginMessage: document.querySelector('#login-message'),
  companySelect: document.querySelector('#company-select'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  currentCompany: document.querySelector('#current-company'),
  currentUser: document.querySelector('#current-user'),
  workOrderForm: document.querySelector('#work-order-form'),
  customerForm: document.querySelector('#customer-form'),
  financeForm: document.querySelector('#finance-form'),
  woList: document.querySelector('#wo-list'),
  customerList: document.querySelector('#customer-list'),
  financeList: document.querySelector('#finance-list'),
};

const appState = {
  token: '',
  companyId: '',
  username: '',
  companies: [],
  workOrders: [],
  customers: [],
  finances: [],
  eventSource: null,
};

boot();

async function boot() {
  const result = await request('/api/companies');
  appState.companies = result.companies;
  refs.companySelect.innerHTML =
    '<option value="">請選擇公司</option>' +
    appState.companies.map((c) => `<option value="${escapeText(c.id)}">${escapeText(c.name)}</option>`).join('');
}

refs.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  refs.loginMessage.textContent = '登入中...';
  try {
    const payload = {
      companyId: refs.companySelect.value,
      username: refs.username.value.trim(),
      password: refs.password.value,
    };
    const result = await request('/api/login', 'POST', payload);
    appState.token = result.token;
    appState.companyId = result.companyId;
    appState.username = result.username;

    const company = appState.companies.find((c) => c.id === appState.companyId);
    refs.currentCompany.textContent = company ? company.name : appState.companyId;
    refs.currentUser.textContent = appState.username;

    refs.loginView.classList.add('hidden');
    refs.dashboardView.classList.remove('hidden');

    connectSync();
    await reloadData();
    refs.loginMessage.textContent = '';
  } catch (error) {
    refs.loginMessage.textContent = error.message;
  }
});

refs.workOrderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await requestAuthed('/api/work-orders', {
    orderNo: value('#wo-no'),
    product: value('#wo-product'),
    qty: value('#wo-qty'),
    status: value('#wo-status'),
  });
  refs.workOrderForm.reset();
});

refs.customerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await requestAuthed('/api/customers', {
    name: value('#customer-name'),
    contact: value('#customer-contact'),
    level: value('#customer-level'),
  });
  refs.customerForm.reset();
});

refs.financeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await requestAuthed('/api/finances', {
    type: value('#finance-type'),
    amount: value('#finance-amount'),
    note: value('#finance-note'),
  });
  refs.financeForm.reset();
});

document.body.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'delete') {
    return;
  }
  await requestAuthed('/api/delete', {
    domain: target.dataset.domain,
    id: target.dataset.id,
  });
});

function connectSync() {
  if (appState.eventSource) {
    appState.eventSource.close();
  }
  appState.eventSource = new EventSource(`/events?token=${encodeURIComponent(appState.token)}`);
  appState.eventSource.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'sync') {
      await reloadData();
    }
  };
}

async function reloadData() {
  const data = await request('/api/bootstrap', 'GET', null, appState.token);
  appState.workOrders = data.workOrders || [];
  appState.customers = data.customers || [];
  appState.finances = data.finances || [];
  render();
}

function render() {
  refs.woList.innerHTML = appState.workOrders
    .map((item) =>
      `<li><strong>${escapeText(item.orderNo)}</strong><div class="item-meta">品名：${escapeText(item.product)}｜數量：${escapeText(item.qty)}｜狀態：${escapeText(item.status)}</div><div class="row-actions"><button data-action="delete" data-domain="workOrders" data-id="${item.id}">刪除</button></div></li>`,
    )
    .join('');

  refs.customerList.innerHTML = appState.customers
    .map((item) =>
      `<li><strong>${escapeText(item.name)}</strong><div class="item-meta">聯絡：${escapeText(item.contact)}｜等級：${escapeText(item.level)}</div><div class="row-actions"><button data-action="delete" data-domain="customers" data-id="${item.id}">刪除</button></div></li>`,
    )
    .join('');

  refs.financeList.innerHTML = appState.finances
    .map((item) =>
      `<li><strong>${escapeText(item.type)} ${escapeText(item.amount)}</strong><div class="item-meta">備註：${escapeText(item.note)}</div><div class="row-actions"><button data-action="delete" data-domain="finances" data-id="${item.id}">刪除</button></div></li>`,
    )
    .join('');
}

async function requestAuthed(url, payload) {
  return request(url, 'POST', payload, appState.token);
}

async function request(url, method = 'GET', payload = null, token = '') {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  if (token) {
    options.headers.Authorization = `Bearer ${token}`;
  }
  if (payload) {
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'request failed');
  }
  return data;
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function escapeText(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
