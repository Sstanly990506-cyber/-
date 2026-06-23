import { $, COMPANY_INFO, downloadCsv, getTodayText } from './shared.js';
import { syncOrderToReceivables } from './store.js';
import { estimateOrderPriceFromRule, findCustomerPriceRule } from './pricing.js';

let lastRecognizedOrder = null;
let aiCorrectionsCache = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

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

function syncAddressFromDownstream(state, onlyWhenEmpty = false) {
  const downstream = $('downstreamInput')?.value || '';
  const customer = findCustomerByName(state, downstream);
  if (!customer?.address || (onlyWhenEmpty && $('orderAddress')?.value.trim())) return false;
  $('downstreamInput').value = customer.name || downstream;
  $('orderAddress').value = customer.address;
  return true;
}

function syncBillingAndUpstream(sourceId = '') {
  const billing = $('billingCustomerInput');
  const upstream = $('upstreamInput');
  if (!billing || !upstream) return '';
  const source = sourceId === 'billingCustomerInput' ? billing : upstream;
  const target = sourceId === 'billingCustomerInput' ? upstream : billing;
  const value = source.value.trim();
  if (value && target.value !== value) target.value = value;
  if (!value && sourceId) target.value = '';
  return upstream.value.trim() || billing.value.trim();
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
  const billingCustomer = $('billingCustomerInput')?.value.trim() || '';
  const downstream = $('downstreamInput').value.trim();
  const upstream = $('upstreamInput').value.trim();
  const glossType = $('glossType').value || '';
  const sheetCount = Number($('sheetCount').value || 0);
  const area = Number($('sizeLength').value || 0) * Number($('sizeWidth').value || 0);

  const priceRule = findCustomerPriceRule(state, {
    billingCustomer,
    glossType,
    sizeLength: $('sizeLength').value,
    sizeWidth: $('sizeWidth').value,
    sizeUnit: $('sizeUnit').value || 'mm',
  });
  const ruleEstimate = estimateOrderPriceFromRule(priceRule, sheetCount);
  if (ruleEstimate) return { estimated: ruleEstimate, source: 'priceRule', rule: priceRule, unitPrice: Number(priceRule.unitPrice || 0) };

  const candidates = state.orders.filter((o) => {
    if (editingId && o.id === editingId) return false;
    if (Number(o.totalPrice || 0) <= 0 || Number(o.sheetCount || 0) <= 0) return false;
    if (glossType && o.glossType !== glossType) return false;
    if (billingCustomer && (o.billingCustomer || '') !== billingCustomer) return false;
    if (!billingCustomer && downstream && o.downstream !== downstream) return false;
    if (!billingCustomer && !downstream && upstream && o.upstream !== upstream) return false;
    return true;
  });

  if (!candidates.length) return null;

  const avgPerSheet = candidates.reduce((sum, o) => sum + Number(o.totalPrice || 0) / Number(o.sheetCount || 1), 0) / candidates.length;
  const estBySheet = sheetCount > 0 ? Math.round(avgPerSheet * sheetCount) : null;
  const avgArea = candidates.reduce((sum, o) => sum + Number(o.sizeLength || 0) * Number(o.sizeWidth || 0), 0) / candidates.length;
  const areaFactor = avgArea > 0 && area > 0 ? area / avgArea : 1;
  const estimated = estBySheet ? Math.max(0, Math.round(estBySheet * areaFactor)) : null;

  return { estimated, source: 'history', candidates: candidates.length, avgPerSheet: Math.round(avgPerSheet) };
}

function updateOrderSmartHint(state) {
  const hint = $('orderSmartHint');
  if (!hint) return;
  const suggestion = findSmartPriceSuggestion(state, $('orderId').value);
  if (!suggestion || !suggestion.estimated) {
    hint.textContent = '智能估價：輸入客人、上光種類、尺寸與計算張數後，系統會先找客人價格表；沒有符合才用歷史工單估算。';
    return;
  }
  if (suggestion.source === 'priceRule') {
    hint.textContent = `客人價格表：符合 ${suggestion.rule.customer} / ${suggestion.rule.glossType || '不限品項'} / 每張 NT$ ${suggestion.unitPrice.toLocaleString()}，預估總價 NT$ ${suggestion.estimated.toLocaleString()}。`;
  } else {
    const basis = $('billingCustomerInput')?.value.trim() ? '同一個客人' : '相近工單';
    hint.textContent = `智能估價：使用 ${suggestion.candidates} 筆${basis}相近尺寸紀錄，預估總價約 NT$ ${suggestion.estimated.toLocaleString()}，平均每張 ${suggestion.avgPerSheet.toLocaleString()}。`;
  }
  if (!$('totalPrice').value) $('totalPrice').value = String(suggestion.estimated);
}

function formatRuleSize(rule) {
  return `${Number(rule.sizeLength || 0).toLocaleString()} x ${Number(rule.sizeWidth || 0).toLocaleString()} ${rule.sizeUnit || 'mm'}`;
}

function clearPriceRuleForm() {
  $('priceRuleForm')?.reset();
  if ($('priceRuleId')) $('priceRuleId').value = '';
  if ($('priceRuleUnit')) $('priceRuleUnit').value = 'mm';
}

function buildPriceRuleFromForm() {
  return {
    id: $('priceRuleId')?.value || crypto.randomUUID(),
    customer: $('priceRuleCustomer')?.value.trim() || '',
    glossType: $('priceRuleGloss')?.value.trim() || '',
    sizeLength: Number($('priceRuleLength')?.value || 0),
    sizeWidth: Number($('priceRuleWidth')?.value || 0),
    sizeUnit: $('priceRuleUnit')?.value || 'mm',
    unitPrice: Number($('priceRuleUnitPrice')?.value || 0),
    note: $('priceRuleNote')?.value.trim() || '',
    updatedAt: new Date().toLocaleString(),
  };
}

function renderPriceRules(state) {
  const body = $('priceRulesTbody');
  if (!body) return;
  const rows = [...(state.priceRules || [])].sort((a, b) => String(a.customer || '').localeCompare(String(b.customer || ''), 'zh-Hant'));
  body.innerHTML = rows.length ? rows.map((rule) => `
    <tr>
      <td>${escapeHtml(rule.customer || '-')}</td>
      <td>${escapeHtml(rule.glossType || '不限')}</td>
      <td>${escapeHtml(formatRuleSize(rule))}</td>
      <td>NT$ ${Number(rule.unitPrice || 0).toLocaleString()}</td>
      <td>
        <button class="btn small" type="button" data-edit-price-rule="${escapeHtml(rule.id)}">編輯</button>
        <button class="btn small ghost" type="button" data-delete-price-rule="${escapeHtml(rule.id)}">刪除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="5">尚未建立客人價格。</td></tr>';
}

function getPriceRuleCustomerMatches(state) {
  const keyword = ($('priceRuleCustomer')?.value || '').trim().toLowerCase();
  if (!keyword) return [];
  return (state.customers || [])
    .filter((customer) => customer.active !== false)
    .filter((customer) => [customer.name, customer.taxId, customer.phone, customer.address]
      .some((value) => String(value || '').toLowerCase().includes(keyword)))
    .sort((a, b) => {
      const aName = String(a.name || '').toLowerCase();
      const bName = String(b.name || '').toLowerCase();
      return Number(!aName.startsWith(keyword)) - Number(!bName.startsWith(keyword))
        || aName.localeCompare(bName, 'zh-Hant');
    })
    .slice(0, 8);
}

function renderPriceRuleCustomerMatches(state) {
  const box = $('priceRuleCustomerMatches');
  if (!box) return;
  const matches = getPriceRuleCustomerMatches(state);
  box.innerHTML = matches.length ? matches.map((customer) => `
    <button class="btn small customer-match-btn" type="button" data-price-rule-customer="${escapeHtml(customer.name || '')}">
      ${escapeHtml(customer.name || '-')}
      ${customer.taxId ? `<span>${escapeHtml(customer.taxId)}</span>` : ''}
    </button>`).join('') : '';
}

function buildOrderFromForm(state) {
  const sheetCount = Number($('sheetCount').value || 0);
  const billingAndUpstream = syncBillingAndUpstream();
  return {
    orderNumber: $('orderNumber').value.trim(),
    orderDate: $('orderDate').value,
    billingCustomer: billingAndUpstream,
    upstream: billingAndUpstream,
    downstream: $('downstreamInput').value.trim(),
    address: $('orderAddress').value.trim(),
    sheetCount,
    sheetCountText: $('sheetCountText').value.trim() || (sheetCount ? String(sheetCount) : ''),
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
      <tr><th>工單編號</th><td>${order.orderNumber || '-'}</td><th>交貨日期</th><td>${order.orderDate || '-'}</td></tr>
      <tr><th>客人</th><td colspan="3">${order.billingCustomer || '-'}</td></tr>
      <tr><th>上游客戶</th><td>${order.upstream || '-'}</td><th>下游客戶</th><td>${order.downstream || '-'}</td></tr>
      <tr><th>地址</th><td colspan="3">${order.address || '-'}</td></tr>
      <tr><th>數量</th><td>${order.sheetCountText || order.sheetCount || '-'}</td><th>計算張數</th><td>${order.sheetCount || '-'}</td></tr>
      <tr><th>尺寸（台吋）</th><td>${taiInchText}</td><th>上光種類</th><td>${order.glossType || '-'}</td></tr>
    </table>
    <div class="footer"><span>客戶簽收：______________</span><span>製單人：______________</span></div>`;
}

export function renderOrderScreen(state) {
  const listScreen = $('ordersListScreen');
  const formScreen = $('ordersFormScreen');
  const pricingScreen = $('ordersPricingScreen');
  const activeScreen = state.orderScreen || 'list';
  listScreen.classList.toggle('hidden', activeScreen !== 'list');
  formScreen.classList.toggle('hidden', activeScreen !== 'form');
  pricingScreen?.classList.toggle('hidden', activeScreen !== 'pricing');

  updateOrderSmartHint(state);
  renderPriceRules(state);
  renderPriceRuleCustomerMatches(state);
  $('exportOrderBtn')?.classList.toggle('hidden', getOrderModuleSettings(state).showExport === false);

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.orderScreen === activeScreen);
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

const AI_FIELD_LABELS = {
  orderNumber: '工單編號',
  orderDate: '交貨日期',
  billingCustomer: '客人',
  upstream: '上游客戶',
  downstream: '下游客戶',
  address: '送貨地址',
  sheetCountText: '數量說明',
  sheetCount: '計算張數',
  sizeLength: '長',
  sizeWidth: '寬',
  sizeUnit: '單位',
  glossType: '上光種類',
  totalPrice: '總價',
};

function correctionRows(correction) {
  return Object.entries(correction?.changes || {}).map(([field, value]) => ({
    id: correction.id,
    field,
    fieldLabel: AI_FIELD_LABELS[field] || field,
    wrong: value?.wrong ?? '',
    correct: value?.correct ?? '',
    confidence: correction.confidence,
    reportedAt: correction.reportedAt,
    reportedBy: correction.reportedBy || '-',
  }));
}

function renderAiCorrectionCenter(rows = aiCorrectionsCache) {
  const body = $('aiCorrectionsTbody');
  const summary = $('aiCorrectionsSummary');
  if (!body) return;
  const flatRows = rows.flatMap(correctionRows);
  if (summary) summary.textContent = `已記錄 ${rows.length} 筆修正案例，${flatRows.length} 個欄位。`;
  body.innerHTML = flatRows.length ? flatRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.fieldLabel)}</td>
      <td>${escapeHtml(row.wrong || '-')}</td>
      <td>${escapeHtml(row.correct || '-')}</td>
      <td>${row.confidence ? `${Math.round(Number(row.confidence) * 100)}%` : '-'}</td>
      <td>${row.reportedAt ? new Date(Number(row.reportedAt)).toLocaleString() : '-'}</td>
      <td>${escapeHtml(row.reportedBy)}</td>
      <td><button class="btn small ghost" type="button" data-delete-ai-correction="${escapeHtml(row.id)}">刪除</button></td>
    </tr>`).join('') : '<tr><td colspan="7">目前還沒有 AI 修正紀錄。</td></tr>';
}

async function loadAiCorrections(state) {
  const body = $('aiCorrectionsTbody');
  if (body) body.innerHTML = '<tr><td colspan="7">正在載入修正紀錄…</td></tr>';
  const res = await fetch('/api/data/aiCorrections?page=1&pageSize=100', {
    headers: { Authorization: `Bearer ${state.authToken || ''}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  aiCorrectionsCache = data.items || [];
  renderAiCorrectionCenter();
}

function exportAiCorrections() {
  const rows = [['欄位', 'AI 原本辨識', '修正後', '信心度', '回報時間', '回報人']];
  aiCorrectionsCache.flatMap(correctionRows).forEach((row) => rows.push([
    row.fieldLabel,
    row.wrong,
    row.correct,
    row.confidence ? `${Math.round(Number(row.confidence) * 100)}%` : '',
    row.reportedAt ? new Date(Number(row.reportedAt)).toLocaleString() : '',
    row.reportedBy,
  ]));
  downloadCsv('AI-修正中心.csv', rows);
}

function getOrderSearchKeyword() {
  return ($('orderSearch')?.value || '').trim().toLowerCase();
}

function matchesOrderSearch(order, keyword) {
  if (!keyword) return true;
  return [
    order.orderNumber,
    order.orderDate,
    order.billingCustomer,
    order.upstream,
    order.downstream,
    order.address,
    order.status,
    order.updatedAt,
  ].some((value) => String(value || '').toLowerCase().includes(keyword));
}

function renderGlossOptions(state) {
  const savedOrderOptions = (state.orders || []).map((order) => order.glossType);
  const savedRuleOptions = (state.priceRules || []).map((rule) => rule.glossType);
  const options = [...new Set([...(state.glossOptions || []), ...savedOrderOptions, ...savedRuleOptions, '其他'].filter(Boolean))];
  state.glossOptions = options;
  ['glossType', 'priceRuleGloss'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.append(o);
    });
    if (options.includes(current)) select.value = current;
  });
}

export function renderOrders(state, renderCustomerOptions) {
  renderGlossOptions(state);
  renderCustomerOptions(state);
  renderOrderStatusOptions(state);
  renderOrderFilters(state);
  renderAiCorrectionCenter();
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
      <td>${order.billingCustomer || '-'}</td>
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
  lastRecognizedOrder = null;
  $('reportAiCorrectionBtn')?.classList.add('hidden');
  document.querySelectorAll('.ai-review-required').forEach((input) => input.classList.remove('ai-review-required'));
}

export function openOrderForEdit(state, orderId) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return false;
  $('orderId').value = order.id;
  $('orderNumber').value = order.orderNumber || '';
  $('orderDate').value = order.orderDate || '';
  $('billingCustomerInput').value = order.upstream || order.billingCustomer || '';
  $('upstreamInput').value = order.upstream || order.billingCustomer || '';
  $('downstreamInput').value = order.downstream || '';
  $('orderAddress').value = order.address || '';
  $('sheetCountText').value = order.sheetCountText || (order.sheetCount ? String(order.sheetCount) : '');
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

async function prepareOrderImage(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('請選擇 JPEG、PNG 或 WebP 圖片。');
  if (file.size > 12 * 1024 * 1024) throw new Error('原始圖片不可超過 12 MB。');
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片。'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error('圖片格式無法解析。'));
    value.src = source;
  });
  let maxDimension = 1600;
  let quality = 0.82;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/jpeg', quality);
    if (encoded.length <= 3_200_000) return encoded;
    maxDimension = Math.round(maxDimension * 0.82);
    quality = Math.max(0.55, quality - 0.06);
  }
  throw new Error('圖片壓縮後仍過大，請裁切圖片或改拍較清晰的工單。');
}

function applyRecognizedOrder(state, order) {
  const billingAndUpstream = order.upstream || order.billingCustomer || '';
  const fields = {
    orderNumber: order.orderNumber, orderDate: order.orderDate, billingCustomerInput: billingAndUpstream, upstreamInput: billingAndUpstream,
    downstreamInput: order.downstream, orderAddress: order.address, sheetCountText: order.sheetCountText, sheetCount: order.sheetCount,
    sizeLength: order.sizeLength, sizeWidth: order.sizeWidth, sizeUnit: order.sizeUnit, totalPrice: order.totalPrice,
  };
  Object.entries(fields).forEach(([id, value]) => {
    if (value === '' || value === null || value === undefined || value === 0) return;
    const input = $(id);
    if (input) input.value = String(value);
  });
  if (order.glossType) {
    if (!state.glossOptions.includes(order.glossType)) state.glossOptions.push(order.glossType);
    renderGlossOptions(state);
    $('glossType').value = order.glossType;
  }
  const addressFilledFromCustomer = syncAddressFromDownstream(state);
  syncBillingAndUpstream();
  updateTaiInchPreview();
  updateOrderSmartHint(state);
  lastRecognizedOrder = { ...order, address: $('orderAddress')?.value.trim() || '' };
  $('reportAiCorrectionBtn')?.classList.remove('hidden');
  document.querySelectorAll('.ai-review-required').forEach((input) => input.classList.remove('ai-review-required'));
  if (Number(order.confidence || 0) < 0.8) {
    Object.keys(fields).forEach((id) => $(id)?.classList.add('ai-review-required'));
    $('glossType')?.classList.add('ai-review-required');
  }
  return addressFilledFromCustomer;
}

function buildAiCorrections(state) {
  if (!lastRecognizedOrder) return {};
  const current = buildOrderFromForm(state);
  const changes = {};
  Object.keys(current).filter((key) => key !== 'status').forEach((key) => {
    const wrong = lastRecognizedOrder[key] ?? '';
    const correct = current[key] ?? '';
    if (String(wrong) !== String(correct)) changes[key] = { wrong, correct };
  });
  return changes;
}

async function reportAiCorrection(state) {
  const changes = buildAiCorrections(state);
  if (!Object.keys(changes).length) return alert('目前沒有發現你修改過的 AI 欄位。');
  const response = await fetch('/api/orders/recognize/corrections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
    body: JSON.stringify({ changes, confidence: lastRecognizedOrder?.confidence }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) return alert(`回報失敗：${data.error || `HTTP ${response.status}`}`);
  lastRecognizedOrder = { ...buildOrderFromForm(state), confidence: lastRecognizedOrder?.confidence };
  $('reportAiCorrectionBtn')?.classList.add('hidden');
  loadAiCorrections(state).catch(() => {});
  alert(`已記錄 ${data.savedFields} 個修正欄位，之後 AI 會參考這些案例。`);
}

async function recognizeOrderFromImage(state) {
  const file = $('aiOrderImage')?.files?.[0];
  if (!file) return alert('請先拍照或選擇工單圖片。');
  const button = $('recognizeOrderBtn');
  const status = $('aiOrderStatus');
  button.disabled = true;
  status.textContent = '正在檢查 AI 設定…';
  try {
    const statusResponse = await fetch('/api/orders/recognize/status', {
      headers: { Authorization: `Bearer ${state.authToken || ''}` },
    });
    const aiStatus = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok || !aiStatus.ok) throw new Error(aiStatus.error || `HTTP ${statusResponse.status}`);
    if (!aiStatus.configured) throw new Error('AI 尚未啟用：請先在 Vercel 設定 OPENAI_API_KEY，然後重新部署。');
    status.textContent = '正在壓縮圖片並識別，通常需要 10 至 60 秒…';
    const image = await prepareOrderImage(file);
    const response = await fetch('/api/orders/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
      body: JSON.stringify({ image, glossOptions: state.glossOptions }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const addressFilledLocally = applyRecognizedOrder(state, data.order || {});
    const addressFilledFromCustomer = data.order?.addressSource === 'customer-system' || addressFilledLocally;
    const confidence = Math.round(Number(data.order?.confidence || 0) * 100);
    const notes = (data.order?.notes || []).filter(Boolean).join('；');
    status.textContent = `識別完成，信心度 ${confidence}%${addressFilledFromCustomer ? '。送貨地址已使用下游客戶系統地址' : ''}${notes ? `。請確認：${notes}` : '。請確認欄位後再儲存。'}`;
  } catch (err) {
    status.textContent = `識別失敗：${err.message}`;
    alert(`AI 識別工單失敗：${err.message}`);
  } finally {
    button.disabled = false;
  }
}

export function bindOrderEvents(state, saveState, renderAll) {
  $('recognizeOrderBtn')?.addEventListener('click', () => recognizeOrderFromImage(state));
  $('reportAiCorrectionBtn')?.addEventListener('click', () => reportAiCorrection(state));
  $('refreshAiCorrectionsBtn')?.addEventListener('click', () => loadAiCorrections(state).catch((err) => alert(`載入 AI 修正紀錄失敗：${err.message}`)));
  $('exportAiCorrectionsBtn')?.addEventListener('click', () => exportAiCorrections());
  $('aiCorrectionsTbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-ai-correction]');
    if (!btn) return;
    if (!window.confirm('確定要刪除這筆 AI 修正紀錄嗎？')) return;
    const res = await fetch(`/api/data/aiCorrections/${encodeURIComponent(btn.dataset.deleteAiCorrection)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.authToken || ''}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return alert(`刪除失敗：${data.error || `HTTP ${res.status}`}`);
    await loadAiCorrections(state);
  });
  loadAiCorrections(state).catch(() => renderAiCorrectionCenter());
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
  $('billingCustomerInput')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('billingCustomerInput')?.addEventListener('change', () => { syncBillingAndUpstream('billingCustomerInput'); updateOrderSmartHint(state); });
  $('upstreamInput')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('upstreamInput')?.addEventListener('change', () => { syncBillingAndUpstream('upstreamInput'); updateOrderSmartHint(state); });
  $('sheetCount')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('glossType')?.addEventListener('change', () => updateOrderSmartHint(state));
  $('exportOrderBtn')?.addEventListener('click', () => {
    openOrderExportWindow(buildOrderFromForm(state));
  });

  $('priceRuleForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const rule = buildPriceRuleFromForm();
    if (!rule.customer || !rule.sizeLength || !rule.sizeWidth || !rule.unitPrice) return alert('請填客人、尺寸與每張單價。');
    const ruleLength = toTaiInch(rule.sizeLength, rule.sizeUnit);
    const ruleWidth = toTaiInch(rule.sizeWidth, rule.sizeUnit);
    const duplicated = state.priceRules.find((item) => item.id !== rule.id
      && String(item.customer || '').trim() === rule.customer
      && String(item.glossType || '').trim() === rule.glossType
      && Math.abs(toTaiInch(item.sizeLength, item.sizeUnit) - ruleLength) <= 0.15
      && Math.abs(toTaiInch(item.sizeWidth, item.sizeUnit) - ruleWidth) <= 0.15);
    if (duplicated && !window.confirm('這個客人、品項與尺寸已經有價格，要覆蓋那筆嗎？')) return;
    if (duplicated) rule.id = duplicated.id;
    const index = state.priceRules.findIndex((item) => item.id === rule.id);
    if (index >= 0) state.priceRules[index] = rule;
    else state.priceRules.unshift(rule);
    clearPriceRuleForm();
    saveState();
    renderAll();
  });

  $('priceRuleCustomer')?.addEventListener('input', () => renderPriceRuleCustomerMatches(state));
  $('priceRuleCustomerMatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-price-rule-customer]');
    if (!btn) return;
    $('priceRuleCustomer').value = btn.dataset.priceRuleCustomer || '';
    $('priceRuleCustomerMatches').innerHTML = '';
  });
  $('clearPriceRuleBtn')?.addEventListener('click', () => {
    clearPriceRuleForm();
    renderPriceRuleCustomerMatches(state);
  });
  $('priceRulesTbody')?.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-price-rule]');
    const remove = e.target.closest('[data-delete-price-rule]');
    const id = edit?.dataset.editPriceRule || remove?.dataset.deletePriceRule || '';
    if (!id) return;
    const rule = state.priceRules.find((item) => item.id === id);
    if (!rule) return;
    if (edit) {
      $('priceRuleId').value = rule.id || '';
      $('priceRuleCustomer').value = rule.customer || '';
      $('priceRuleGloss').value = rule.glossType || '';
      $('priceRuleLength').value = rule.sizeLength || '';
      $('priceRuleWidth').value = rule.sizeWidth || '';
      $('priceRuleUnit').value = rule.sizeUnit || 'mm';
      $('priceRuleUnitPrice').value = rule.unitPrice || '';
      $('priceRuleNote').value = rule.note || '';
      renderPriceRuleCustomerMatches(state);
      $('priceRuleCustomer')?.focus();
      return;
    }
    if (remove && window.confirm('確定刪除這筆客人價格嗎？')) {
      state.priceRules = state.priceRules.filter((item) => item.id !== id);
      saveState();
      renderAll();
    }
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
