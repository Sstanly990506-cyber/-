import { $, getTodayText, money } from './shared.js';
import { syncOrderToReceivables } from './store.js';

function toTaiInch(value, unit) {
  const num = Number(value || 0);
  if (!num) return 0;
  const mm = unit === 'cm' ? num * 10 : unit === 'inch' ? num * 25.4 : unit === 'tai-inch' ? num * 30.3 : num;
  return mm / 30.3;
}

function updateTaiInchPreview() {
  const unit = $('sizeUnit').value || 'mm';
  const l = toTaiInch($('sizeLength').value, unit);
  const w = toTaiInch($('sizeWidth').value, unit);
  $('sizeTaiInch').value = l && w ? `${l.toFixed(2)} × ${w.toFixed(2)} 台吋` : '';
}


function buildOrderFromForm() {
  return {
    orderNumber: $('orderNumber').value.trim(),
    orderDate: $('orderDate').value,
    upstream: $('upstreamInput').value.trim(),
    downstream: $('downstreamInput').value.trim(),
    address: $('orderAddress').value.trim(),
    sheetCount: Number($('sheetCount').value || 0),
    sizeLength: Number($('sizeLength').value || 0),
    sizeWidth: Number($('sizeWidth').value || 0),
    sizeUnit: $('sizeUnit').value || 'mm',
    glossType: $('glossType').value || '',
    totalPrice: Number($('totalPrice').value || 0),
    status: $('orderStatus').value || '未完成',
  };
}

function openOrderExportWindow(order) {
  if (!order.orderNumber) {
    alert('請先填寫工單編號再匯出工單');
    return;
  }

  const html = `<!doctype html>
  <html lang="zh-Hant"><head><meta charset="UTF-8" />
  <title>工單匯出</title>
  <style>
  body{font-family:"Noto Sans TC",sans-serif;padding:12px;color:#111}
  .copy{border:2px solid #555;padding:10px;margin-bottom:12px}
  h2{margin:0 0 8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #777;padding:6px;text-align:left}
  .footer{display:flex;justify-content:space-between;margin-top:12px}
  </style></head>
  <body>
    <div class="copy">
      <h2>工單</h2>
      ${renderOrderTable(order)}
    </div>
    <script>window.print();</script>
  </body></html>`;

  const win = window.open('', '_blank', 'width=900,height=760');
  if (!win) {
    alert('無法開啟匯出視窗，請確認瀏覽器未封鎖彈出視窗');
    return;
  }
  win.document.write(html);
  win.document.close();
}

function renderOrderTable(order) {
  return `
    <table>
      <tr><th>工單編號</th><td>${order.orderNumber || '-'}</td><th>日期</th><td>${order.orderDate || '-'}</td></tr>
      <tr><th>上游客戶</th><td>${order.upstream || '-'}</td><th>下游客戶</th><td>${order.downstream || '-'}</td></tr>
      <tr><th>地址</th><td colspan="3">${order.address || '-'}</td></tr>
      <tr><th>張數</th><td>${order.sheetCount || 0}</td><th>狀態</th><td>${order.status || '-'}</td></tr>
      <tr><th>尺寸</th><td>${order.sizeLength || 0} × ${order.sizeWidth || 0} ${order.sizeUnit || ''}</td><th>上光種類</th><td>${order.glossType || '-'}</td></tr>
      <tr><th>總價</th><td colspan="3">NT$ ${money(order.totalPrice || 0)}</td></tr>
    </table>
    <div class="footer"><span>客戶簽收：______________</span><span>製單人：______________</span></div>`;
}

export function renderOrderScreen(state) {
  const listScreen = $('ordersListScreen');
  const formScreen = $('ordersFormScreen');
  const isList = state.orderScreen === 'list';
  listScreen.classList.toggle('hidden', !isList);
  formScreen.classList.toggle('hidden', isList);

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.orderScreen === state.orderScreen);
  });
}

function renderGlossOptions(state) {
  const select = $('glossType');
  select.innerHTML = '';
  state.glossOptions.forEach((opt) => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    select.append(o);
  });
}

export function renderOrders(state, renderCustomerOptions) {
  renderGlossOptions(state);
  renderCustomerOptions(state);
  const body = $('ordersTbody');
  body.innerHTML = '';

  const filtered = state.orders.filter((order) => (state.orderStatusFilter === '全部' ? true : order.status === state.orderStatusFilter));

  filtered.forEach((order) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${order.orderNumber || '-'}</td>
      <td>${order.orderDate || '-'}</td>
      <td>${order.upstream || '-'}</td>
      <td>${order.downstream || '-'}</td>
      <td>${Number(order.totalPrice || 0).toLocaleString()}</td>
      <td>${order.status || '未完成'}</td>
      <td>${order.updatedAt || '-'}</td>
      <td>
        <button class="btn" data-edit="${order.id}">編輯</button>
        <button class="btn" data-quick-status="已完成" data-id="${order.id}">已完成</button>
        <button class="btn" data-quick-status="已送出" data-id="${order.id}">已送出</button>
      </td>`;
    body.append(tr);
  });
}

export function clearOrderForm() {
  $('orderForm').reset();
  $('orderId').value = '';
  $('orderDate').value = getTodayText();
  $('sizeTaiInch').value = '';
}

export function bindOrderEvents(state, saveState, renderAll) {
  $('addGlossBtn')?.addEventListener('click', () => {
    const input = $('newGlossType');
    const val = input.value.trim();
    if (!val) return;
    if (!state.glossOptions.includes(val)) state.glossOptions.push(val);
    input.value = '';
    saveState();
    renderAll();
  });

  $('orderForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('orderId').value || crypto.randomUUID();
    const existing = state.orders.find((o) => o.id === id);
    const payload = {
      id,
      ...buildOrderFromForm(),
      updatedAt: new Date().toLocaleString(),
    };

    if (existing) {
      if (existing.totalPrice !== payload.totalPrice) {
        state.audits.unshift({
          orderNumber: payload.orderNumber,
          field: '總價',
          before: existing.totalPrice,
          after: payload.totalPrice,
          changedAt: new Date().toLocaleString(),
          user: state.user,
          device: `${location.hostname || 'localhost'} / ${navigator.userAgent.slice(0, 40)}...`,
        });
      }
      Object.assign(existing, payload);
      syncOrderToReceivables(existing);
    } else {
      syncOrderToReceivables(payload);
      state.orders.unshift(payload);
    }

    saveState();
    clearOrderForm();
    state.orderScreen = 'list';
    renderAll();
  });

  $('ordersTbody')?.addEventListener('click', (e) => {
    const quickBtn = e.target.closest('button[data-quick-status]');
    if (quickBtn) {
      const order = state.orders.find((o) => o.id === quickBtn.dataset.id);
      if (!order) return;
      const before = order.status;
      order.status = quickBtn.dataset.quickStatus;
      order.updatedAt = new Date().toLocaleString();
      state.audits.unshift({
        orderNumber: order.orderNumber || '(空白)',
        field: '狀態',
        before,
        after: order.status,
        changedAt: new Date().toLocaleString(),
        user: state.user || '未登入',
        device: `${location.hostname || 'localhost'} / ${navigator.userAgent.slice(0, 40)}...`,
      });
      syncOrderToReceivables(order);
      saveState();
      renderAll();
      return;
    }

    const btn = e.target.closest('button[data-edit]');
    if (!btn) return;
    const order = state.orders.find((o) => o.id === btn.dataset.edit);
    if (!order) return;

    $('orderId').value = order.id;
    $('orderNumber').value = order.orderNumber || '';
    $('orderDate').value = order.orderDate || '';
    $('upstreamInput').value = order.upstream || '';
    $('downstreamInput').value = order.downstream || '';
    $('orderAddress').value = order.address || '';
    $('sheetCount').value = order.sheetCount || '';
    $('sizeLength').value = order.sizeLength || '';
    $('sizeWidth').value = order.sizeWidth || '';
    $('sizeUnit').value = order.sizeUnit || 'mm';
    $('glossType').value = order.glossType || '';
    $('totalPrice').value = order.totalPrice || '';
    $('orderStatus').value = order.status || '未完成';
    state.orderScreen = 'form';
    renderOrderScreen(state);
  });

  $('clearOrderBtn')?.addEventListener('click', () => { clearOrderForm(); updateTaiInchPreview(); });

  ['sizeLength', 'sizeWidth', 'sizeUnit'].forEach((id) => {
    $(id)?.addEventListener('input', updateTaiInchPreview);
    $(id)?.addEventListener('change', updateTaiInchPreview);
  });
  updateTaiInchPreview();
  $('exportOrderBtn')?.addEventListener('click', () => {
    openOrderExportWindow(buildOrderFromForm());
  });

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.orderScreen = btn.dataset.orderScreen;
      renderOrderScreen(state);
    });
  });

  document.querySelectorAll('[data-status-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.orderStatusFilter = btn.dataset.statusFilter;
      document.querySelectorAll('[data-status-filter]').forEach((filterBtn) => {
        filterBtn.classList.toggle('active', filterBtn.dataset.statusFilter === state.orderStatusFilter);
      });
      renderAll();
    });
  });
}
