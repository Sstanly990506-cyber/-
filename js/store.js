import { formatTs, getTodayText, getDefaultSettings, mergeSettings } from './shared.js';

const ENTITY_MAP = {
  customers:'customers',
  orders:'orders',
  audits:'audits',
  receivables:'receivables',
  payables:'payables',
  priceRules:'priceRules',
  inventoryItems:'inventory',
  systemEvents:'events',
  lineDestinations:'lineDestinations',
};

const REVERSE_ENTITY = Object.fromEntries(
  Object.entries(ENTITY_MAP).map(([key, value]) => [value, key]),
);
const WRITE_VIEWS = {
  customers: 'customersView', orders: 'ordersView', audits: 'auditView',
  receivables: 'financeView', payables: 'financeView', priceRules: 'ordersView',
  inventoryItems: 'inventoryView', systemEvents: 'notificationsView',
  lineDestinations: 'notificationsView',
};

const ROLE_KEYS = {
  admin: Object.keys(ENTITY_MAP),
  ops: ['customers', 'orders', 'priceRules', 'inventoryItems', 'systemEvents', 'lineDestinations'],
  finance: ['receivables', 'payables', 'systemEvents', 'lineDestinations'],
  audit: ['audits', 'systemEvents', 'lineDestinations'],
  driver:['customers','orders'],
  viewer: [],
};

const VIEW_KEYS = {
  ordersView: ['customers', 'orders', 'priceRules'],
  customersView: ['customers'],
  tripsView:['customers','orders'],
  opsCenterView: ['orders', 'systemEvents'],
  inventoryView: ['inventoryItems'],
  notificationsView: ['systemEvents', 'lineDestinations'],
  financeView: ['receivables', 'payables', 'systemEvents'],
  auditView: ['audits', 'systemEvents'],
};

const PAGER_ANCHORS = {
  customers: 'customersTbody',
  orders: 'ordersTbody',
  audits: 'auditTbody',
  inventoryItems: 'inventoryTbody',
};

const SEARCH_INPUTS = {
  customers: 'customerSearch',
  orders: 'orderSearch',
  inventoryItems: 'inventorySearch',
};

export const state = {
  user: null,
  userRole: 'viewer',
  allowedViews: null,
  glossOptions: [],
  customers: [],
  orders: [],
  audits: [],
  receivables: [],
  payables: [],
  priceRules: [],
  systemEvents: [],
  lineDestinations: [],
  settings: getDefaultSettings(),
  inventoryItems: [],
  pagination: {},
  serverReport: null,
  reportRange: { start: '', end: '' },
  financeScreen: 'main',
  auditFilter: { start: '', end: '', keyword: '', user: '', field: '', anomalyOnly: false },
  orderStatusFilter: '全部',
  orderScreen: 'list',
  authToken: null,
};

let onRefresh = () => {};
let onSyncUi = () => {};
let syncTimer = null;
let changeCursor = 0;
let initializedRemote = false;
let searchBound = false;
let saveQueue = Promise.resolve();
let sessionVersion = 0;

const snapshots = {};
const pageRequests = {};

function headers(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
  };
}

async function jsonRequest(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function setUi(text, source, ok = true) {
  onSyncUi({
    badgeText: text,
    detailText: `${text}：${formatTs(Date.now())}（${source}）`,
    ok,
  });
}

function cleanRecord(row) {
  const result = { ...row };
  delete result._updatedAt;
  return result;
}

function snapshot(key) {
  snapshots[key] = new Map(
    (state[key] || [])
      .filter((row) => row?.id)
      .map((row) => [row.id, JSON.stringify(row)]),
  );
}

function normalizeMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function normalizeSortOrder(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(rows) {
  return [
    ...new Map((rows || []).filter((row) => row?.id).map((row) => [row.id, row])).values(),
  ];
}

function normalizeStateData() {
  state.customers = unique(state.customers).map((c) => ({
    ...c,
    taxId:String(c.taxId??''),
  }));

  state.orders = unique(state.orders).map((o) => ({
    ...o,
    billingCustomer:String(o.billingCustomer??''),
    upstream: String(o.upstream ?? ''),
    machineType: ['BIG', 'REGULAR', 'SMALL'].includes(o.machineType) ? o.machineType : 'BIG',
    sortOrder:o.sortOrder===null || o.sortOrder === undefined || o.sortOrder === ''
      ? null
      : normalizeSortOrder(o.sortOrder),
    totalPrice: normalizeMoney(o.totalPrice),
    sheetCount: normalizeMoney(o.sheetCount),
    sheetCountText:String(o.sheetCountText??o.sheetCount??''),
  }));

  state.receivables = unique(state.receivables);
  state.payables = unique(state.payables);

  state.priceRules = unique(state.priceRules).map((rule) => ({
    ...rule,
    customer: String(rule.customer ?? ''),
    glossType: String(rule.glossType ?? ''),
    machineType: ['BIG', 'REGULAR', 'SMALL'].includes(rule.machineType) ? rule.machineType : 'ANY',
    pricingMode: rule.pricingMode || 'legacy-per-sheet',
    sizeLength: normalizeMoney(rule.sizeLength),
    sizeWidth: normalizeMoney(rule.sizeWidth),
    sizeLengthTai: normalizeMoney(rule.sizeLengthTai),
    sizeWidthTai: normalizeMoney(rule.sizeWidthTai),
    sizeUnit: rule.sizeUnit || 'mm',
    unitPrice: normalizeMoney(rule.unitPrice),
  }));

  state.inventoryItems = unique(state.inventoryItems);
  state.audits = (state.audits || []).slice(0, 500);
  state.systemEvents = (state.systemEvents || []).slice(0, 500);
  state.settings = mergeSettings(state.settings || {});
}

function renderAllPagers() {
  for (const [key, anchor] of Object.entries(PAGER_ANCHORS)) {
    renderPager(key, anchor);
  }
}

function refresh() {
  onRefresh();
  queueMicrotask(renderAllPagers);
}

export function setAuthToken(token) {
  if (state.authToken !== (token || null)) {
    sessionVersion += 1;
    initializedRemote = false;
    changeCursor = 0;
    for (const key of Object.keys(ENTITY_MAP)) {
      state[key] = [];
      snapshots[key] = new Map();
    }
    state.pagination = {};
    state.serverReport = null;
  }
  state.authToken = token || null;
  window.dispatchEvent(new Event('app:auth-changed'));
}

export function configureStore({ refreshFn, syncUiFn }) {
  onRefresh = refreshFn;
  onSyncUi = syncUiFn;
}

export function initializeStore() {
  try {
    state.settings = mergeSettings(JSON.parse(localStorage.getItem('uiSettings') || 'null') || {});
  } catch {
    state.settings = getDefaultSettings();
  }

  const now = new Date();
  state.reportRange.start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  state.reportRange.end = now.toISOString().slice(0, 10);
  setUi('已儲存', '等待登入');
}

export async function loadEntityPage(key, page = 1, query = '', refreshUi = true) {
  const version = sessionVersion;
  await saveQueue;
  if (version !== sessionVersion) return;
  const entity = ENTITY_MAP[key] || key;
  const stateKey = REVERSE_ENTITY[entity] || key;
  const request = (pageRequests[stateKey] || 0) + 1;
  pageRequests[stateKey] = request;
  const localBefore = JSON.stringify(state[stateKey]);
  const data = await jsonRequest(
    `/api/data/${entity}?page=${page}&pageSize=100&q=${encodeURIComponent(query)}`,
    { headers: headers() },
  );
  if (version !== sessionVersion || pageRequests[stateKey] !== request) return data;
  if (JSON.stringify(state[stateKey]) !== localBefore) {
    setUi('保留本機變更', '請稍後重新搜尋', false);
    return data;
  }

  state[stateKey] = data.items || [];
  state.pagination[stateKey] = {
    page: data.page,
    pages: data.pages,
    total: data.total,
    query,
  };

  normalizeStateData();
  snapshot(stateKey);
  if (refreshUi) refresh();
  return data;
}

export function renderPager(key, anchorId) {
  const anchor = document.getElementById(anchorId);
  if (!anchor) return;

  let pager = anchor.parentElement?.querySelector(`.data-pager[data-key="${key}"]`);
  if (!pager) {
    pager = document.createElement('div');
    pager.className = 'filter-row data-pager';
    pager.dataset.key = key;
    anchor.parentElement?.append(pager);
  }

  const meta = state.pagination[key] || { page: 1, pages: 1, total: (state[key] || []).length };
  const localTotal = (state[key] || []).length;
  const displayTotal=Number(meta.pages || 1) <= 1
    ? localTotal
    : Math.max(Number(meta.total || 0), localTotal);

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = '上一頁';
  prev.disabled = meta.page <= 1;
  prev.onclick = () => loadEntityPage(key, meta.page - 1, meta.query || '');

  const text = document.createElement('span');
  text.className = 'sync-detail';
  text.textContent = `第 ${meta.page} / ${Math.max(meta.pages, 1)} 頁，共 ${displayTotal} 筆`;

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = '下一頁';
  next.disabled = meta.page >= meta.pages;
  next.onclick = () => loadEntityPage(key, meta.page + 1, meta.query || '');

  pager.replaceChildren(prev, text, next);
}

function bindServerSearch() {
  if (searchBound) return;
  searchBound = true;

  for (const [key, inputId] of Object.entries(SEARCH_INPUTS)) {
    const input = document.getElementById(inputId);
    if (!input) continue;

    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadEntityPage(key, 1, input.value).catch((err) => setUi('搜尋失敗', err.message, false));
      }, 300);
    });
  }
}

async function loadEntityPagesInBackground(keys,concurrency=2) {
  let cursor = 0;
  const version = sessionVersion;

  async function worker() {
    while (cursor < keys.length && version === sessionVersion) {
      const key = keys[cursor];
      cursor += 1;
      try {
        await loadEntityPage(key, 1, '', false);
      } catch (err) {
        console.warn(`背景載入 ${key} 失敗`, err);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
}

function applyInitialPages(initialPages = {}) {
  for (const [entity, data] of Object.entries(initialPages || {})) {
    const stateKey = REVERSE_ENTITY[entity] || entity;
    if (!stateKey || !(stateKey in state)) continue;

    state[stateKey] = data.items || [];
    state.pagination[stateKey] = {
      page: data.page || 1,
      pages: data.pages || 1,
      total: data.total || 0,
      query: '',
    };
    snapshot(stateKey);
  }
}

function dataKeysForAccount() {
  if (Array.isArray(state.allowedViews)) {
    return [...new Set(state.allowedViews.flatMap((viewId) => VIEW_KEYS[viewId] || []))];
  }
  return ROLE_KEYS[state.userRole] || [];
}

export function hydrateBootstrap(base = {}, source = '登入預載') {
  state.glossOptions = base.glossOptions || ['PVA光', 'PVB光/油', '耐磨', '壓光', '其他'];
  state.settings = mergeSettings(base.settings || state.settings);
  changeCursor = Number(base.syncTick || 0);
  initializedRemote = true;

  const keys = dataKeysForAccount();
  applyInitialPages(base.initialPages || {});
  normalizeStateData();
  for (const entity of Object.keys(base.initialPages || {})) snapshot(REVERSE_ENTITY[entity] || entity);
  refresh();
  bindServerSearch();

  const loadedKeys = new Set(
    Object.keys(base.initialPages || {}).map((entity) => REVERSE_ENTITY[entity] || entity),
  );
  const missingKeys = keys.filter((key) => !loadedKeys.has(key));
  if (missingKeys.length) {
    const version = sessionVersion;
    setUi('載入中', '背景資料', false);
    loadEntityPagesInBackground(missingKeys).then(() => {
      if (version !== sessionVersion) return;
      normalizeStateData();
      refresh();
      setUi('已儲存', '分頁資料庫');
    });
  } else {
    setUi('已儲存', source);
  }
}

async function loadBootstrap() {
  const version = sessionVersion;
  setUi('載入中', '伺服器資料', false);
  const base = await jsonRequest('/api/bootstrap', { headers: headers() });
  if (version !== sessionVersion) return;
  hydrateBootstrap(base, '伺服器資料');
}

export async function loadServerReport() {
  const version = sessionVersion;
  try {
    const data = await jsonRequest('/api/reports/summary', { headers: headers() });
    if (version !== sessionVersion) return null;
    state.serverReport = data.summary || null;
    return state.serverReport;
  } catch {
    return null;
  }
}

async function pushChanges() {
  if (!state.authToken) return;
  const version = sessionVersion;

  const jobs = [];
  for (const [key, entity] of Object.entries(ENTITY_MAP)) {
    if (state.userRole !== 'admin') {
      if (key === 'lineDestinations') continue;
      if (Array.isArray(state.allowedViews) && !state.allowedViews.includes(WRITE_VIEWS[key])) continue;
    }
    const before = snapshots[key] || new Map();
    const current = new Set();

    for (const row of state[key] || []) {
      if (!row?.id) continue;

      current.add(row.id);
      const encoded = JSON.stringify(row);
      if (before.get(row.id) !== encoded) {
        jobs.push(jsonRequest(
          `/api/data/${entity}/${encodeURIComponent(row.id)}`,
          {
            method: 'PUT',
            headers: headers(true),
            body: JSON.stringify(cleanRecord(row)),
          },
        ).then(() => {
          if (version === sessionVersion) {
            snapshots[key] ||= new Map();
            snapshots[key].set(row.id, encoded);
          }
        }));
      }
    }

    for (const id of before.keys()) {
      if (!current.has(id)) {
        jobs.push(jsonRequest(
          `/api/data/${entity}/${encodeURIComponent(id)}`,
          { method: 'DELETE', headers: headers() },
        ).then(() => {
          if (version === sessionVersion) snapshots[key]?.delete(id);
        }));
      }
    }
  }

  if (!jobs.length) return;

  setUi('儲存中', '送出變更', false);
  const results = await Promise.allSettled(jobs);
  if (version !== sessionVersion) return;
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  setUi('已儲存', '單筆同步');
}

function applyChange(change) {
  const key = REVERSE_ENTITY[change.entity];
  if (!key) return;

  const rows = state[key] || [];
  const index = rows.findIndex((row) => row.id === change.id);
  const baseline = snapshots[key] || new Map();
  const local = index >= 0 ? JSON.stringify(rows[index]) : undefined;
  if (local !== baseline.get(change.id)) return;
  if (change.deleted) {
    if (index >= 0) rows.splice(index, 1);
    baseline.delete(change.id);
    return key;
  }

  const next = { ...(change.data || {}), id: change.id, _updatedAt: change.updatedAt };
  if (index >= 0) rows[index] = next;
  else if (rows.length < 100) rows.unshift(next);
  if (rows.some((row) => row.id === change.id)) baseline.set(change.id, JSON.stringify(next));
  snapshots[key] = baseline;
  return key;
}

export async function pullServerState() {
  if (!state.authToken) return;
  const version = sessionVersion;
  await saveQueue;
  if (version !== sessionVersion) return;
  if (!initializedRemote) {
    await loadBootstrap();
    return;
  }

  try {
    const data = await jsonRequest(`/api/changes?since=${changeCursor}&limit=5000`, { headers: headers() });
    if (version !== sessionVersion) return;
    const applied = (data.changes || []).filter((change) => applyChange(change));
    changeCursor = Number(data.cursor || changeCursor);
    normalizeStateData();
    for (const change of applied) {
      const key = REVERSE_ENTITY[change.entity];
      const row = state[key].find((item) => item.id === change.id);
      if (row) snapshots[key].set(change.id, JSON.stringify(row));
    }
    if (data.changes?.length) refresh();
    setUi('已儲存', '增量同步');
  } catch (err) {
    setUi('同步失敗', err.message, false);
  }
}

export function startStoreSync() {
  bindServerSearch();
  if (syncTimer) return;
  syncTimer = setInterval(pullServerState, 10000);
}

export function saveState() {
  normalizeStateData();
  localStorage.setItem('uiSettings', JSON.stringify(state.settings));
  const version = sessionVersion;
  saveQueue = saveQueue.then(() => {
    if (version === sessionVersion) return pushChanges();
  }).catch((err) => setUi('儲存失敗', err.message, false));
  return saveQueue;
}

export function appendSystemEvent(message, level = 'info', meta = {}) {
  if (
    state.userRole !== 'admin'
    && Array.isArray(state.allowedViews)
    && !state.allowedViews.includes('notificationsView')
  ) {
    return;
  }

  state.systemEvents.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    user: state.user || 'system',
    level,
    message,
    meta,
  });
  if (state.systemEvents.length > 500) state.systemEvents.length = 500;
}

export function getIntegrityReport() {
  const issues = [];
  const seen = new Set();

  state.orders.forEach((order) => {
    const no = (order.orderNumber || '').trim();
    if (!no) issues.push({ level: 'warning', text: '有工單缺少編號' });
    if (no && seen.has(no)) issues.push({ level: 'critical', text: `工單編號重複：${no}` });
    seen.add(no);
  });

  return {
    total: issues.length,
    critical: issues.filter((item) => item.level === 'critical').length,
    warning: issues.filter((item) => item.level === 'warning').length,
    info: 0,
    issues: issues.slice(0, 10),
  };
}

export function getOrderReceivableKey(order) {
  return (order.orderNumber || '').trim() || `ORDER-${order.id}`;
}

export function syncOrderToReceivables(order) {
  const key = getOrderReceivableKey(order);
  const index = state.receivables.findIndex((row) => (row.orderNumber || '').trim() === key);
  const shouldLink = ['已完成', '已送出'].includes(order.status) && Number(order.totalPrice || 0) > 0;

  if (!shouldLink) {
    if (index >= 0 && state.receivables[index].source === 'auto-order') {
      state.receivables.splice(index, 1);
    }
    return;
  }

  const row = {
    id: index >= 0 ? state.receivables[index].id : crypto.randomUUID(),
    source: 'auto-order',
    date: order.orderDate || getTodayText(),
    customer: order.billingCustomer || order.downstream || order.upstream || '-',
    orderNumber: key,
    amount: Number(order.totalPrice || 0),
    received: index >= 0 ? Number(state.receivables[index].received || 0) : 0,
  };

  if (index >= 0) state.receivables[index] = row;
  else state.receivables.unshift(row);
}
