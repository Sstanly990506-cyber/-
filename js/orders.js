import { $, COMPANY_INFO, downloadCsv, getTodayText } from './shared.js';
import { syncOrderToReceivables } from './store.js';
import { calculateOrderQuote, classifyOrderPricingTier, coatingTypeCode, normalizeCustomerTierBounds, normalizePricingTier, toTaiInch } from './pricing.js';
import { COATING_LABELS, formatRuleSize, isCustomerPricingConfigRule, isCustomerTierPriceRule, pricingTierLabel } from './orders-pricing.js';
import { openOrderExportWindow as openOrderExportWindowFromModule } from './orders-export.js';
import { bindOrderDrag } from './orders-drag.js?v=20260714-ai-speed-1';

let lastRecognizedOrder = null;
let aiCorrectionsCache = [];
let lastAutoPrice = 0;
let highlightedOrderId = null;
const ORDER_ENTRY_FIELD_IDS = [
  'orderNumber',
  'orderDate',
  'billingCustomerInput',
  'upstreamInput',
  'downstreamInput',
  'orderAddress',
  'sheetCountText',
  'sheetCount',
  'sizeLength',
  'sizeWidth',
  'sizeUnit',
  'machineType',
  'glossType',
  'totalPrice',
  'orderStatus',
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function updateTaiInchPreview() {
  const unit = $('sizeUnit').value || 'mm';
  const l = toTaiInch($('sizeLength').value, unit);
  const w = toTaiInch($('sizeWidth').value, unit);
  $('sizeTaiInch').value = l && w ? `天 ${l.toFixed(2)} × 地 ${w.toFixed(2)} 台吋` : '';
}

function bindOrderEnterNavigation() {
  const controls = ORDER_ENTRY_FIELD_IDS.map((id) => $(id)).filter(Boolean);
  controls.forEach((control, index) => {
    control.enterKeyHint = index === controls.length - 1 ? 'done' : 'next';
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      const next = controls[index + 1] || $('saveOrderBtn');
      next?.focus();
    });
  });
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

function sortedOrders(state) {
  return state.orders
    .map((order, index) => ({ order, index }))
    .sort((a, b) => {
      const aOrder = Number.isFinite(a.order.sortOrder) ? a.order.sortOrder : a.index;
      const bOrder = Number.isFinite(b.order.sortOrder) ? b.order.sortOrder : b.index;
      return aOrder - bOrder || a.index - b.index;
    })
    .map(({ order }) => order);
}

function normalizeOrderPositions(state) {
  sortedOrders(state).forEach((order, index) => {
    order.sortOrder = index;
  });
}

function reorderOrder(state, orderId, targetId, after = false) {
  if (!orderId || !targetId || orderId === targetId) return false;
  const ordered = sortedOrders(state);
  const sourceIndex = ordered.findIndex((order) => order.id === orderId);
  if (sourceIndex < 0) return false;
  const [current] = ordered.splice(sourceIndex, 1);
  const targetIndex = ordered.findIndex((order) => order.id === targetId);
  if (targetIndex < 0) return false;
  ordered.splice(targetIndex + (after ? 1 : 0), 0, current);
  ordered.forEach((order, index) => { order.sortOrder = index; });
  return true;
}

function findSmartPriceSuggestion(state, editingId = '') {
  const billingCustomer = $('billingCustomerInput')?.value.trim() || '';
  const downstream = $('downstreamInput').value.trim();
  const glossType = $('glossType').value || '';
  const sheetCount = Number($('sheetCount').value || 0);
  const area = Number($('sizeLength').value || 0) * Number($('sizeWidth').value || 0);

  const formulaQuote = calculateOrderQuote(state, {
    billingCustomer,
    glossType,
    sizeLength: $('sizeLength').value,
    sizeWidth: $('sizeWidth').value,
    sizeUnit: $('sizeUnit').value || 'mm',
    machineType: getSelectedPricingTier(state),
    sheetCount,
  });
  if (formulaQuote) return { ...formulaQuote, estimated: formulaQuote.finalPrice };

  const candidates = state.orders.filter((o) => {
    if (editingId && o.id === editingId) return false;
    if (Number(o.totalPrice || 0) <= 0 || Number(o.sheetCount || 0) <= 0) return false;
    if (glossType && o.glossType !== glossType) return false;
    if (billingCustomer && (o.billingCustomer || '') !== billingCustomer) return false;
    if (!billingCustomer && downstream && o.downstream !== downstream) return false;
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

function getSelectedPricingTier(state) {
  const manual = $('machineType')?.value || '';
  if (manual) return manual;
  return classifyOrderPricingTier(state, {
    billingCustomer: $('billingCustomerInput')?.value.trim() || $('priceRuleCustomer')?.value.trim() || '',
    sizeLength: $('sizeLength')?.value,
    sizeWidth: $('sizeWidth')?.value,
    sizeUnit: $('sizeUnit')?.value || 'tai-inch',
  });
}

function updateOrderSmartHint(state) {
  const hint = $('orderSmartHint');
  if (!hint) return;
  const suggestion = findSmartPriceSuggestion(state, $('orderId').value);
  if (!suggestion || !suggestion.estimated) {
    hint.textContent = '智能估價：輸入客人、上光種類、尺寸與計算張數後，系統會先找客人價格表；沒有符合才用歷史工單估算。';
    return;
  }
  if (suggestion.source !== 'history') {
    const tierLabel = pricingTierLabel(suggestion.pricingTier);
    const unitLabel = suggestion.pricingMode === 'sheet' ? '單張價' : '元／令';
    const source = suggestion.customerRule ? `客人專屬${unitLabel} ${suggestion.unitPrice.toLocaleString()}` : `預設${unitLabel} ${suggestion.unitPrice.toLocaleString()}`;
    const adjustments = [
      suggestion.minimumApplied ? '已套用最低收費' : '',
    ].filter(Boolean).join('、');
    hint.textContent = `公式報價：${tierLabel}，${source}，計算價 NT$ ${suggestion.calculatedPrice.toLocaleString()}，最終報價 NT$ ${suggestion.finalPrice.toLocaleString()}${adjustments ? `（${adjustments}）` : ''}。`;
  } else {
    const basis = $('billingCustomerInput')?.value.trim() ? '同一個客人' : '相近工單';
    hint.textContent = `智能估價：使用 ${suggestion.candidates} 筆${basis}相近尺寸紀錄，預估總價約 NT$ ${suggestion.estimated.toLocaleString()}，平均每張 ${suggestion.avgPerSheet.toLocaleString()}。`;
  }
  const currentPrice = Number($('totalPrice').value || 0);
  if (!currentPrice || currentPrice === lastAutoPrice) {
    $('totalPrice').value = String(suggestion.estimated);
    lastAutoPrice = suggestion.estimated;
  }
}

function clearPriceMatrix() {
  document.querySelectorAll('#priceRuleMatrix input[data-price-tier][data-price-coating]').forEach((input) => { input.value = ''; });
}

function defaultPriceBounds(state) {
  return normalizeCustomerTierBounds({}, state.settings?.moduleInternals?.orders?.pricingRules);
}

function clearPriceBounds(state) {
  fillPriceBounds(defaultPriceBounds(state));
}

function customerBoundsRule(state, customerName) {
  const customer = String(customerName || '').trim().toLowerCase();
  if (!customer) return null;
  return (state.priceRules || []).find((rule) => (
    rule?.priceScope === 'customer-tier-bounds'
    && String(rule.customer || '').trim().toLowerCase() === customer
  ));
}

function fillPriceBounds(bounds) {
  const normalized = normalizeCustomerTierBounds(bounds);
  document.querySelectorAll('#priceRuleBounds input[data-price-bound-tier][data-price-bound-edge]').forEach((input) => {
    const tier = input.dataset.priceBoundTier;
    const edge = input.dataset.priceBoundEdge;
    input.value = normalized?.[tier]?.[edge] ?? '';
  });
}

function matrixRulesForCustomer(state, customerName) {
  const customer = String(customerName || '').trim().toLowerCase();
  if (!customer) return [];
  return (state.priceRules || []).filter((rule) => String(rule.customer || '').trim().toLowerCase() === customer && isCustomerTierPriceRule(rule));
}

function fillPriceMatrixFromCustomer(state, customerName) {
  clearPriceMatrix();
  fillPriceBounds(customerBoundsRule(state, customerName)?.tierBounds || defaultPriceBounds(state));
  const rules = matrixRulesForCustomer(state, customerName);
  rules.forEach((rule) => {
    const coating = coatingTypeCode(rule.glossType);
    const tier = normalizePricingTier(rule.machineType);
    const input = document.querySelector(`#priceRuleMatrix input[data-price-tier="${tier}"][data-price-coating="${coating}"]`);
    if (input) input.value = rule.unitPrice || '';
  });
  const note = rules.find((rule) => rule.note)?.note || '';
  if ($('priceRuleNote')) $('priceRuleNote').value = note;
}

function clearPriceRuleForm(state) {
  $('priceRuleForm')?.reset();
  if ($('priceRuleId')) $('priceRuleId').value = '';
  clearPriceMatrix();
  clearPriceBounds(state);
}

function populatePriceRuleFromOrder(state) {
  const customer = $('billingCustomerInput')?.value.trim() || '';
  $('priceRuleCustomer').value = customer;
  fillPriceMatrixFromCustomer(state, customer);
}

function updatePriceRuleFormulaPreview(state) {
  const pricing = state.settings?.moduleInternals?.orders?.pricingRules || {};
  const divisor = Number(pricing.divisor || 4680);
  const formula = $('priceRuleFormulaText');
  if (formula) formula.textContent = `先用天／地門檻判斷小台、常規或大台；大台/常規＝天台吋 × 地台吋 × 張數 × 元／令 ÷（${divisor.toLocaleString()} × 100）；小台＝張數 × 單張價。`;

  const quantity = Number($('sheetCount')?.value || 0);
  const previewState = {
    ...state,
    priceRules: buildPriceRulesFromForm(),
  };
  const quote = calculateOrderQuote(previewState, {
    billingCustomer: $('priceRuleCustomer')?.value.trim() || '',
    glossType: $('glossType')?.value || '',
    sizeLength: $('sizeLength')?.value,
    sizeWidth: $('sizeWidth')?.value,
    sizeUnit: $('sizeUnit')?.value || 'tai-inch',
    machineType: $('machineType')?.value || '',
    sheetCount: quantity,
  });
  $('priceRuleCalculatedPrice').textContent = quote ? `NT$ ${quote.calculatedPrice.toLocaleString()}` : '請輸入完整資料';
  $('priceRuleFinalPrice').textContent = quote ? `NT$ ${quote.finalPrice.toLocaleString()}` : '請輸入完整資料';
  if ($('priceRuleFormulaNote')) {
    $('priceRuleFormulaNote').textContent = quote
      ? `張數 ${quantity.toLocaleString()}，${pricingTierLabel(quote.pricingTier)} ${quote.pricingMode === 'sheet' ? '單張價' : '元／令'} ${quote.unitPrice.toLocaleString()}${quote.minimumApplied ? '，已套用最低收費' : ''}。`
      : '請先在新增工單填入計算張數，並補齊客人、品項、尺寸與單價。';
  }
}

function buildPriceRulesFromForm() {
  const customer = $('priceRuleCustomer')?.value.trim() || '';
  const note = $('priceRuleNote')?.value.trim() || '';
  const updatedAt = new Date().toLocaleString();
  const tierBounds = {};
  document.querySelectorAll('#priceRuleBounds input[data-price-bound-tier][data-price-bound-edge]').forEach((input) => {
    const tier = input.dataset.priceBoundTier;
    const edge = input.dataset.priceBoundEdge;
    if (!tierBounds[tier]) tierBounds[tier] = {};
    tierBounds[tier][edge] = Number(input.value || 0);
  });
  const boundsRule = {
    id: crypto.randomUUID(),
    customer,
    glossType: '',
    machineType: 'ANY',
    pricingMode: 'formula',
    priceScope: 'customer-tier-bounds',
    tierBounds: normalizeCustomerTierBounds(tierBounds),
    note,
    updatedAt,
  };
  const matrixRules = [...document.querySelectorAll('#priceRuleMatrix input[data-price-tier][data-price-coating]')]
    .map((input) => ({
      tier: input.dataset.priceTier,
      coating: input.dataset.priceCoating,
      unitPrice: Number(input.value || 0),
    }))
    .filter((item) => item.unitPrice > 0)
    .map((item) => ({
      id: crypto.randomUUID(),
      customer,
      glossType: COATING_LABELS[item.coating] || item.coating,
      sizeLength: 0,
      sizeWidth: 0,
      sizeUnit: 'tai-inch',
      sizeLengthTai: 0,
      sizeWidthTai: 0,
      machineType: item.tier,
      pricingMode: 'formula',
      priceScope: 'customer-tier',
      unitPrice: item.unitPrice,
      note,
      updatedAt,
    }));
  return [boundsRule, ...matrixRules];
}

function renderPriceRules(state) {
  const body = $('priceRulesTbody');
  if (!body) return;
  const rows = [...(state.priceRules || [])]
    .filter((rule) => rule?.priceScope !== 'customer-tier-bounds')
    .sort((a, b) => String(a.customer || '').localeCompare(String(b.customer || ''), 'zh-Hant'));
  body.innerHTML = rows.length ? rows.map((rule) => `
    <tr>
      <td>${escapeHtml(rule.customer || '-')}</td>
      <td>${escapeHtml(rule.glossType || '不限')}</td>
      <td>${escapeHtml(formatRuleSize(rule))}</td>
      <td>${rule.machineType === 'ANY' ? '全部' : pricingTierLabel(rule.machineType)}</td>
      <td>${rule.machineType === 'SMALL' ? '單張價' : '元／令'} NT$ ${Number(rule.unitPrice || 0).toLocaleString()}</td>
      <td>
        <button class="btn small" type="button" data-edit-price-rule="${escapeHtml(rule.id)}">編輯</button>
        <button class="btn small ghost" type="button" data-delete-price-rule="${escapeHtml(rule.id)}">刪除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6">尚未建立客人價格。</td></tr>';
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
  const billingCustomer = $('billingCustomerInput')?.value.trim() || '';
  return {
    orderNumber: $('orderNumber').value.trim(),
    orderDate: $('orderDate').value,
    billingCustomer,
    upstream: $('upstreamInput')?.value.trim() || '',
    downstream: $('downstreamInput').value.trim(),
    address: $('orderAddress').value.trim(),
    sheetCount,
    sheetCountText: $('sheetCountText').value.trim() || (sheetCount ? String(sheetCount) : ''),
    sizeLength: Number($('sizeLength').value || 0),
    sizeWidth: Number($('sizeWidth').value || 0),
    sizeUnit: $('sizeUnit').value || 'mm',
    machineType: getSelectedPricingTier(state),
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
  const taiInchText = taiInch && taiInchW ? `天 ${taiInch.toFixed(2)} × 地 ${taiInchW.toFixed(2)} 台吋` : '-';
  return `
    <table>
      <tr><th>工單編號</th><td>${order.orderNumber || '-'}</td><th>交貨日期</th><td>${order.orderDate || '-'}</td></tr>
      <tr><th>客人</th><td colspan="3">${order.billingCustomer || '-'}</td></tr>
      <tr><th>上游客戶</th><td>${order.upstream || '-'}</td><th>下游客戶</th><td>${order.downstream || '-'}</td></tr>
      <tr><th>地址</th><td colspan="3">${order.address || '-'}</td></tr>
      <tr><th>數量</th><td>${order.sheetCountText || order.sheetCount || '-'}</td><th>計算張數</th><td>${order.sheetCount || '-'}</td></tr>
      <tr><th>天／地（台吋）</th><td>${taiInchText}</td><th>上光種類</th><td>${order.glossType || '-'}</td></tr>
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
  updatePriceRuleFormulaPreview(state);
  const orderSettings = getOrderModuleSettings(state);
  $('exportOrderBtn')?.classList.toggle('hidden', orderSettings.showExport === false);
  $('aiOrderRecognizer')?.classList.toggle('hidden', orderSettings.showAiTools === false);
  $('aiCorrectionCenter')?.classList.toggle('hidden', orderSettings.showAiTools === false);

  document.querySelectorAll('[data-order-screen]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.orderScreen === activeScreen);
  });
}

function getOrderModuleSettings(state) {
  return state.settings?.moduleInternals?.orders || { statuses: { '未完成': true, '已送出': true, '已完成': true }, quickActions: { '已送出': true, '已完成': true }, showFilters: true, showExport: true, showAiTools: true };
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
  sizeLength: '天',
  sizeWidth: '地',
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
  if (getOrderModuleSettings(state).showAiTools === false) return;
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
  ['glossType'].forEach((id) => {
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
  const settings = getOrderModuleSettings(state);
  const aiEnabled = settings.showAiTools !== false;
  $('aiOrderRecognizer')?.classList.toggle('hidden', !aiEnabled);
  $('aiCorrectionCenter')?.classList.toggle('hidden', !aiEnabled);
  if (aiEnabled) renderAiCorrectionCenter();
  const body = $('ordersTbody');
  body.innerHTML = '';

  const visibleStatuses = new Set(getEnabledOrderStatuses(state));
  const keyword = getOrderSearchKeyword();
  const filtered = sortedOrders(state)
    .filter((order) => visibleStatuses.has(order.status || '未完成'))
    .filter((order) => (state.orderStatusFilter === '全部' ? true : order.status === state.orderStatusFilter))
    .filter((order) => matchesOrderSearch(order, keyword));

  const summary = $('ordersListSummary');
  if (summary) summary.textContent = `顯示 ${filtered.length} 筆，共 ${state.orders.length} 筆工單`;

  if (!filtered.length) {
    body.innerHTML = '<tr class="orders-empty-row"><td colspan="5">目前沒有符合條件的工單。</td></tr>';
    return;
  }

  filtered.forEach((order, index) => {
    const tr = document.createElement('tr');
    const status = order.status || '未完成';
    const customer = order.billingCustomer || order.upstream || order.downstream || '-';
    const sent = status === '已送出';
    const completed = status === '已完成';
    const showSentAction = settings.quickActions?.['已送出'] !== false;
    const showDoneAction = settings.quickActions?.['已完成'] !== false;
    const quickActions = [
      showSentAction
        ? `<button class="btn small order-sent-action" type="button" data-quick-status="已送出" data-id="${escapeHtml(order.id)}" ${sent ? 'disabled' : ''}>已送出</button>`
        : '',
      showDoneAction
        ? `<button class="btn primary small" type="button" data-quick-status="已完成" data-id="${escapeHtml(order.id)}" ${completed ? 'disabled' : ''}>${completed ? '已完成' : '完成'}</button>`
        : '',
    ].filter(Boolean).join('');
    tr.className = `order-preview-row${highlightedOrderId === order.id ? ' is-just-completed' : ''}`;
    tr.dataset.edit = order.id;
    tr.style.setProperty('--row-index', String(Math.min(index, 12)));
    tr.innerHTML = `
      <td data-label="工單單號" class="order-number-copy" data-copy-order="${escapeHtml(order.id)}" title="雙擊複製成新工單"><button class="order-drag-handle" type="button" data-order-drag-handle="${escapeHtml(order.id)}" title="長按後拖拉調整順序">拖拉</button><span><strong>${escapeHtml(order.orderNumber || '-')}</strong><small>雙擊複製</small></span></td>
      <td data-label="交貨日期" class="order-preview-date"><strong>${escapeHtml(order.orderDate || '-')}</strong></td>
      <td data-label="客人" class="order-preview-customer"><strong>${escapeHtml(customer)}</strong></td>
      <td data-label="狀態" class="order-preview-status"><span class="order-status-badge" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span></td>
      <td data-label="操作" class="order-row-actions">
        ${quickActions || '<span class="sub">無快速操作</span>'}
      </td>`;
    body.append(tr);
  });

  if (highlightedOrderId) {
    const currentId = highlightedOrderId;
    window.setTimeout(() => {
      Array.from(document.querySelectorAll('tr[data-edit]'))
        .find((row) => row.dataset.edit === currentId)
        ?.classList.remove('is-just-completed');
      if (highlightedOrderId === currentId) highlightedOrderId = null;
    }, 1100);
  }
}

export function clearOrderForm() {
  $('orderForm').reset();
  $('orderId').value = '';
  $('orderDate').value = getTodayText();
  $('sizeUnit').value = 'tai-inch';
  $('machineType').value = '';
  $('sizeTaiInch').value = '';
  lastAutoPrice = 0;
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
  $('billingCustomerInput').value = order.billingCustomer || order.upstream || '';
  $('upstreamInput').value = order.upstream || '';
  $('downstreamInput').value = order.downstream || '';
  $('orderAddress').value = order.address || '';
  $('sheetCountText').value = order.sheetCountText || (order.sheetCount ? String(order.sheetCount) : '');
  $('sheetCount').value = order.sheetCount || '';
  $('sizeLength').value = order.sizeLength || '';
  $('sizeWidth').value = order.sizeWidth || '';
  $('sizeUnit').value = order.sizeUnit || 'tai-inch';
  $('machineType').value = order.machineType || 'BIG';
  $('glossType').value = order.glossType || '';
  $('totalPrice').value = order.totalPrice || '';
  $('orderStatus').value = order.status || '未完成';
  state.orderScreen = 'form';
  renderOrderScreen(state);
  updateOrderSmartHint(state);
  $('exportOrderBtn')?.classList.toggle('hidden', getOrderModuleSettings(state).showExport === false);
  return true;
}

function copyOrderAsNew(state, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return false;
  clearOrderForm();
  $('orderNumber').value = '';
  $('orderDate').value = order.orderDate || getTodayText();
  $('billingCustomerInput').value = order.billingCustomer || '';
  $('upstreamInput').value = order.upstream || '';
  $('downstreamInput').value = order.downstream || '';
  $('orderAddress').value = order.address || '';
  $('sheetCountText').value = order.sheetCountText || (order.sheetCount ? String(order.sheetCount) : '');
  $('sheetCount').value = order.sheetCount || '';
  $('sizeLength').value = order.sizeLength || '';
  $('sizeWidth').value = order.sizeWidth || '';
  $('sizeUnit').value = order.sizeUnit || 'tai-inch';
  $('machineType').value = order.machineType || 'BIG';
  $('glossType').value = order.glossType || '';
  $('totalPrice').value = order.totalPrice || '';
  $('orderStatus').value = '未完成';
  state.orderScreen = 'form';
  renderOrderScreen(state);
  updateTaiInchPreview();
  updateOrderSmartHint(state);
  $('orderNumber')?.focus();
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
  // Full camera photos are larger than the recognition request needs.
  let maxDimension = 1024;
  let quality = 0.68;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/jpeg', quality);
    if (encoded.length <= 900_000) return encoded;
    maxDimension = Math.round(maxDimension * 0.82);
    quality = Math.max(0.55, quality - 0.06);
  }
  throw new Error('圖片壓縮後仍過大，請裁切圖片或改拍較清晰的工單。');
}

function applyRecognizedOrder(state, order) {
  const billingCustomer = order.billingCustomer || order.upstream || '';
  const fields = {
    orderNumber: order.orderNumber, orderDate: order.orderDate, billingCustomerInput: billingCustomer, upstreamInput: order.upstream,
    downstreamInput: order.downstream, orderAddress: order.address, sheetCountText: order.sheetCountText, sheetCount: order.sheetCount,
    sizeLength: order.sizeLength, sizeWidth: order.sizeWidth, sizeUnit: order.sizeUnit, machineType: order.machineType, totalPrice: order.totalPrice,
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
  const startedAt = performance.now();
  button.disabled = true;
  status.textContent = '正在壓縮圖片並識別，通常需要 5 至 30 秒…';
  try {
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
    const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const notes = (data.order?.notes || []).filter(Boolean).join('；');
    status.textContent = `識別完成，耗時 ${elapsedSeconds} 秒，信心度 ${confidence}%${addressFilledFromCustomer ? '。送貨地址已使用下游客戶系統地址' : ''}${notes ? `。請確認：${notes}` : '。請確認欄位後再儲存。'}`;
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
  if (getOrderModuleSettings(state).showAiTools !== false) {
    loadAiCorrections(state).catch(() => renderAiCorrectionCenter());
  }
  $('orderForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('orderId').value || crypto.randomUUID();
    const existing = state.orders.find((o) => o.id === id);
    const payload = {
      id,
      ...buildOrderFromForm(state),
      sortOrder: existing?.sortOrder ?? Math.min(0, ...state.orders.map((order) => Number(order.sortOrder) || 0)) - 1,
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
    const deleteBtn = e.target.closest('button[data-delete-order]');
    if (deleteBtn) {
      const index = state.orders.findIndex((order) => order.id === deleteBtn.dataset.deleteOrder);
      if (index < 0) return;
      const order = state.orders[index];
      const label = order.orderNumber || '未命名工單';
      if (!window.confirm(`確定要刪除工單「${label}」嗎？刪除後無法復原。`)) return;
      state.orders.splice(index, 1);
      for (let i = state.receivables.length - 1; i >= 0; i -= 1) {
        const receivable = state.receivables[i];
        if (receivable.source === 'auto-order' && receivable.orderNumber === order.orderNumber) {
          state.receivables.splice(i, 1);
        }
      }
      saveState();
      renderAll();
      return;
    }

    const quickBtn = e.target.closest('button[data-quick-status]');
    if (quickBtn) {
      const order = state.orders.find((o) => o.id === quickBtn.dataset.id);
      if (!order) return;
      if (order.status === '已送出') return;
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
      highlightedOrderId = order.id;
      saveState();
      renderAll();
      return;
    }

    const btn = e.target.closest('button[data-edit]');
    if (btn) {
      openOrderForEdit(state, btn.dataset.edit);
      return;
    }
    const row = e.target.closest('[data-copy-order], [data-order-drag-handle]') ? null : e.target.closest('tr[data-edit]');
    if (row) openOrderForEdit(state, row.dataset.edit);
  });
  $('ordersTbody')?.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('[data-copy-order]');
    if (!cell) return;
    copyOrderAsNew(state, cell.dataset.copyOrder);
  });
  bindOrderDrag($('ordersTbody'), (orderId, targetId, after) => reorderOrder(state, orderId, targetId, after), saveState, renderAll);

  $('clearOrderBtn')?.addEventListener('click', () => { clearOrderForm(); updateTaiInchPreview(); updateOrderSmartHint(state); });
  bindOrderEnterNavigation();

  ['sizeLength', 'sizeWidth', 'sizeUnit', 'machineType'].forEach((id) => {
    $(id)?.addEventListener('input', () => { updateTaiInchPreview(); updateOrderSmartHint(state); });
    $(id)?.addEventListener('change', () => { updateTaiInchPreview(); updateOrderSmartHint(state); });
  });
  updateTaiInchPreview();

  $('downstreamInput')?.addEventListener('change', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('downstreamInput')?.addEventListener('blur', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('downstreamInput')?.addEventListener('input', () => { syncAddressFromDownstream(state); updateOrderSmartHint(state); });
  $('billingCustomerInput')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('billingCustomerInput')?.addEventListener('change', () => updateOrderSmartHint(state));
  $('upstreamInput')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('sheetCount')?.addEventListener('input', () => updateOrderSmartHint(state));
  $('glossType')?.addEventListener('change', () => updateOrderSmartHint(state));
  $('exportOrderBtn')?.addEventListener('click', () => {
    openOrderExportWindowFromModule(buildOrderFromForm(state));
  });

  $('priceRuleForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const customer = $('priceRuleCustomer')?.value.trim() || '';
    const rules = buildPriceRulesFromForm();
    if (!customer) return alert('請先選擇或輸入客人。');
    if (!rules.some(isCustomerTierPriceRule)) return alert('請至少填一個客人專屬價格。');
    const customerKey = customer.toLowerCase();
    state.priceRules = state.priceRules.filter((item) => !(String(item.customer || '').trim().toLowerCase() === customerKey && isCustomerPricingConfigRule(item)));
    state.priceRules.unshift(...rules);
    clearPriceRuleForm(state);
    saveState();
    renderAll();
  });

  $('priceRuleForm')?.addEventListener('input', () => updatePriceRuleFormulaPreview(state));
  $('priceRuleForm')?.addEventListener('change', () => updatePriceRuleFormulaPreview(state));
  $('priceRuleCustomer')?.addEventListener('input', () => {
    renderPriceRuleCustomerMatches(state);
    fillPriceMatrixFromCustomer(state, $('priceRuleCustomer')?.value || '');
    updatePriceRuleFormulaPreview(state);
  });
  $('priceRuleCustomerMatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-price-rule-customer]');
    if (!btn) return;
    $('priceRuleCustomer').value = btn.dataset.priceRuleCustomer || '';
    $('priceRuleCustomerMatches').innerHTML = '';
    fillPriceMatrixFromCustomer(state, $('priceRuleCustomer')?.value || '');
    updatePriceRuleFormulaPreview(state);
  });
  $('clearPriceRuleBtn')?.addEventListener('click', () => {
    clearPriceRuleForm(state);
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
      fillPriceMatrixFromCustomer(state, rule.customer || '');
      renderPriceRuleCustomerMatches(state);
      updatePriceRuleFormulaPreview(state);
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
      if (btn.id === 'openPriceRulesFromOrderBtn') {
        populatePriceRuleFromOrder(state);
      }
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
