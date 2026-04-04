import { $, COMPANY_INFO, getTodayText } from './shared.js';
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


function findCustomerByName(state, keyword) {
  const key = (keyword || '').trim().toLowerCase();
  if (!key) return null;
  return state.customers.find((c) => (c.name || '').trim().toLowerCase() === key)
    || state.customers.find((c) => (c.name || '').toLowerCase().includes(key));
}

function syncAddressFromDownstream(state) {
  const downstream = $('downstreamInput')?.value || '';
  const customer = findCustomerByName(state, downstream);
  if (!customer) return;
  $('downstreamInput').value = customer.name || downstream;
  $('orderAddress').value = customer.address || '';
}


function nextOrderNumber(state) {
  const d = getTodayText().replaceAll('-', '');
  const prefix = `WO-${d}-`;
  const seq = state.orders
    .map((o) => o.orderNumber || '')
    .filter((n) => n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)) || 0);
  const next = (Math.max(0, ...seq) + 1).toString().padStart(3, '0');
  return `${prefix}${next}`;
}

function findSmartPriceSuggestion(state, editingId = '') {
  const downstream = $('downstreamInput').value.trim();
  const upstream = $('upstreamInput').value.trim();
  const glossType = $('glossType').value || '';
  const sheetCount = Number($('sheetCount').value || 0);
  const area = Number($('sizeLength').value || 0) * Number($('sizeWidth').value || 0);

  const candidates = state.orders.filter((o) => {
    if (editingId && o.id === editingId) return false;
    if (Number(o.totalPrice || 0) <= 0 || Number(o.sheetCount || 0) <= 0) return false;
    if (glossType && o.glossType !== glossType) return false;
    if (downstream && o.downstream !== downstream) return false;
    if (!downstream && upstream && o.upstream !== upstream) return false;
    return true;
  });

  if (!candidates.length) return null;

  const avgPerSheet = candidates.reduce((sum, o) => sum + Number(o.totalPrice || 0) / Number(o.sheetCount || 1), 0) / candidates.length;
  const estBySheet = sheetCount > 0 ? Math.round(avgPerSheet * sheetCount) : null;
  const avgArea = candidates.reduce((sum, o) => sum + Number(o.sizeLength || 0) * Number(o.sizeWidth || 0), 0) / candidates.length;
  const areaFactor = avgArea > 0 && area > 0 ? area / avgArea : 1;
  const estimated = estBySheet ? Math.max(0, Math.round(estBySheet * areaFactor)) : null;

  return { estimated, candidates: candidates.length, avgPerSheet: Math.round(avgPerSheet) };
}

function updateOrderSmartHint(state) {
  const hint = $('orderSmartHint');
  if (!hint) return;
  const suggestion = findSmartPriceSuggestion(state, $('orderId').value);
  if (!suggestion || !suggestion.estimated) {
    hint.textContent = '智能建議：填入客戶 / 上光種類 / 張數後，系統會自動估算建議總價。';
    return;
  }
  hint.textContent = `智能建議：依 ${suggestion.candidates} 筆歷史工單估算，建議總價約 NT$ ${suggestion.estimated.toLocaleString()}（平均每張 ${suggestion.avgPerSheet.toLocaleString()}）`;
  if (!$('totalPrice').value) $('totalPrice').value = String(suggestion.estimated);
}


function buildOrderFromForm(state) {
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
    status: $('orderStatus').value || getEnabledOrderStatuses(state)[0],
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
      <h2>${COMPANY_INFO.name} 工單</h2><p>${COMPANY_INFO.address}</p>
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
  const taiInch = toTaiInch(order.sizeLength, order.sizeUnit);
  const taiInchW = toTaiInch(order.sizeWidth, order.sizeUnit);
  const taiInchText = taiInch && taiInchW ? `${taiInch.toFixed(2)} × ${taiInchW.toFixed(2)} 台吋` : '-';
  return `
    <table>
      <tr><th>工單編號</th><td>${order.orderNumber || '-'}</td><th>日期</th><td>${order.orderDate || '-'}</td></tr>
      <tr><th>上游客戶</th><td>${order.upstream || '-'}</td><th>下游客戶</th><td>${order.downstream || '-'}</td></tr>
      <tr><th>地址</th><td colspan="3">${order.address || '-'}</td></tr>
      <tr><th>張數</th><td>${order.sheetCount || 0}</td><th>狀態</th><td>${order.status || '-'}</td></tr>
      <tr><th>尺寸（台吋）</th><td>${taiInchText}</td><th>上光種類</th><td>${order.glossType || '-'}</td></tr>
    </table>
    <div class="footer"><span>客戶簽收：______________</span><span>製單人：______________</span></div>`;
}

export function renderOrderScreen(state) {
  const listScreen = $('ordersListScreen');
  const formScreen = $('ordersFormScreen');
  const isList = state.orderScreen === 'list';
  listScreen.classList.toggle('hidden', !isList);
  formScreen.classList.toggle('hidden', isList);

  updateOrderSmartHint(state);
  $('exportOrderBtn')?.classList.toggle('hidden', getOrderModuleSettings(state).showExport === false);

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.orderScreen === state.orderScreen);
  });
}

function getOrderModuleSettings(state) {
  return state.settings?.moduleInternals?.orders || { statuses: { '未完成': true, '已送出': true, '已完成': true }, quickActions: { '已送出': true, '已完成': true }, showFilters: true, showExport: true };
}

function getEnabledOrderStatuses(state) {
  const settings = getOrderModuleSettings(state);
  const statuses = ['未完成', '已送出', '已完成'].filter((status) => settings.statuses?.[status] !== false);
  return statuses.length ? statuses : ['未完成'];
}

function renderOrderStatusOptions(state) {
  const select = $('orderStatus');
  if (!select) return;
  const statuses = getEnabledOrderStatuses(state);
  const current = select.value;
  select.innerHTML = statuses.map((status) => `<option value="${status}">${status}</option>`).join('');
  select.value = statuses.includes(current) ? current : statuses[0];
}

function renderOrderFilters(state) {
  const wrap = $('orderStatusFilters');
  if (!wrap) return;
  const settings = getOrderModuleSettings(state);
  wrap.classList.toggle('hidden', settings.showFilters === false);
  const statuses = getEnabledOrderStatuses(state);
  const items = ['全部', ...statuses];
  if (!items.includes(state.orderStatusFilter)) state.orderStatusFilter = '全部';
  wrap.innerHTML = items.map((status) => `<button class="btn filter-btn ${state.orderStatusFilter === status ? 'active' : ''}" data-status-filter="${status}" type="button">${status}</button>`).join('');
}

function getOrderSearchKeyword() {
  return ($('orderSearch')?.value || '').trim().toLowerCase();
}

function matchesOrderSearch(order, keyword) {
  if (!keyword) return true;
  return [
    order.orderNumber,
    order.orderDate,
    order.upstream,
    order.downstream,
    order.address,
    order.status,
    order.updatedAt,
  ].some((value) => String(value || '').toLowerCase().includes(keyword));
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
  renderOrderStatusOptions(state);
  renderOrderFilters(state);
  const body = $('ordersTbody');
  body.innerHTML = '';

  const settings = getOrderModuleSettings(state);
  const visibleStatuses = new Set(getEnabledOrderStatuses(state));
  const keyword = getOrderSearchKeyword();
  const filtered = state.orders
    .filter((order) => visibleStatuses.has(order.status || '未完成'))
    .filter((order) => (state.orderStatusFilter === '全部' ? true : order.status === state.orderStatusFilter))
    .filter((order) => matchesOrderSearch(order, keyword));

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
        ${settings.quickActions?.['已完成'] && visibleStatuses.has('已完成') ? `<button class="btn" data-quick-status="已完成" data-id="${order.id}">已完成</button>` : ''}
        ${settings.quickActions?.['已送出'] && visibleStatuses.has('已送出') ? `<button class="btn" data-quick-status="已送出" data-id="${order.id}">已送出</button>` : ''}
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

export function openOrderForEdit(state, orderId) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return false;
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
  updateOrderSmartHint(state);
  $('exportOrderBtn')?.classList.toggle('hidden', getOrderModuleSettings(state).showExport === false);
  return true;
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
      ...buildOrderFromForm(state),
      updatedAt: new Date().toLocaleString(),
    };

    if (!payload.orderNumber) payload.orderNumber = nextOrderNumber(state);
    const duplicated = state.orders.find((o) => o.id !== id && (o.orderNumber || '').trim() === payload.orderNumber.trim());
    if (duplicated) return alert(`工單編號已存在：${payload.orderNumber}`);

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
    openOrderForEdit(state, btn.dataset.edit);
  });

  $('clearOrderBtn')?.addEventListener('click', () => { clearOrderForm(); updateTaiInchPreview(); updateOrderSmartHint(state); });

  ['sizeLength', 'sizeWidth', 'sizeUnit'].forEach((id) => {
    $(id)?.addEventListener('input', () => { updateTaiInchPreview(); updateOrderSmartHint(state); });
    $(id)?.addEventListener('change', () => { updateTaiInchPreview(); updateOrderSmartHint(state); });
  });
  updateTaiInchPreview();

  $('downstreamInput')?.addEventListener('change', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('downstreamInput')?.addEventListener('blur', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('downstreamInput')?.addEventListener('input', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('upstreamInput')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('sheetCount')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('glossType')?.addEventListener('change', () => updateOrderSmartHint(state));
  $('exportOrderBtn')?.addEventListener('click', () => {
    openOrderExportWindow(buildOrderFromForm(state));
  });

  updateOrderSmartHint(state);
  $('exportOrderBtn')?.classList.toggle('hidden', getOrderModuleSettings(state).showExport === false);

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.orderScreen = btn.dataset.orderScreen;
      renderOrderScreen(state);
    });
  });

  $('orderStatusFilters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status-filter]');
    if (!btn) return;
    state.orderStatusFilter = btn.dataset.statusFilter;
    renderAll();
  });

  $('orderSearch')?.addEventListener('input', () => renderAll());
  $('orderSearch')?.addEventListener('change', () => renderAll());
}
