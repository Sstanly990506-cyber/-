import { formatTs, getTodayText, getDefaultSettings, mergeSettings } from './shared.js';

const STORAGE_KEYS = ['glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables', 'systemEvents', 'settings', 'inventoryItems', 'users'];
const API_STATE_URL = '/api/state';

export const state = {
  user: null,
  userRole: 'viewer',
  financePassword: '123',
  glossOptions: [],
  customers: [],
  orders: [],
  audits: [],
  receivables: [],
  payables: [],
  systemEvents: [],
  settings: getDefaultSettings(),
  inventoryItems: [],
  users: [],
  reportRange: { start: '', end: '' },
  financeScreen: 'main',
  auditFilter: { start: '', end: '', keyword: '' },
  orderStatusFilter: '全部',
  orderScreen: 'list',
};

let lastSyncAt = 0;
let pendingSyncTick = 0;
let serverSyncEnabled = true;
let fileModeOnly = false;
let onRefresh = () => {};
let onSyncUi = () => {};

function applyStatePayload(payload) {
  state.glossOptions = payload.glossOptions || ['PVA光', 'PVB光/油', '耐磨', '壓光'];
  state.customers = payload.customers || [];
  state.orders = payload.orders || [];
  state.audits = payload.audits || [];
  state.receivables = payload.receivables || [];
  state.payables = payload.payables || [];
  state.systemEvents = payload.systemEvents || [];
  state.settings = mergeSettings(payload.settings || state.settings || {});
  state.inventoryItems = payload.inventoryItems || [];
  state.users = payload.users || [];
  state.financePassword = state.settings.financePassword;
}

function readStorageJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadLocalState() {
  applyStatePayload({
    glossOptions: readStorageJson('glossOptions', ['PVA光', 'PVB光/油', '耐磨', '壓光']),
    customers: readStorageJson('customers', []),
    orders: readStorageJson('orders', []),
    audits: readStorageJson('audits', []),
    receivables: readStorageJson('receivables', []),
    payables: readStorageJson('payables', []),
    systemEvents: readStorageJson('systemEvents', []),
    settings: readStorageJson('settings', null),
    inventoryItems: readStorageJson('inventoryItems', []),
<<<<<< codex-d2sdch
    users: readStorageJson('users', []),
=======
>>>>>> main
  });
}

function saveLocalState(now) {
  localStorage.setItem('glossOptions', JSON.stringify(state.glossOptions));
  localStorage.setItem('customers', JSON.stringify(state.customers));
  localStorage.setItem('orders', JSON.stringify(state.orders));
  localStorage.setItem('audits', JSON.stringify(state.audits));
  localStorage.setItem('receivables', JSON.stringify(state.receivables));
  localStorage.setItem('payables', JSON.stringify(state.payables));
  localStorage.setItem('systemEvents', JSON.stringify(state.systemEvents));
  localStorage.setItem('settings', JSON.stringify(state.settings));
  localStorage.setItem('inventoryItems', JSON.stringify(state.inventoryItems));
  localStorage.setItem('users', JSON.stringify(state.users));
  localStorage.setItem('syncTick', String(now));
}

function setSyncUi(badgeText, source, ts = Date.now()) {
  onSyncUi({ badgeText, detailText: `最後更新：${formatTs(ts)}（${source}）`, ok: true });
}

async function readJsonOrThrow(res) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const message = payload?.error ? `${res.status} ${payload.error}` : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

async function pushServerState(syncTick) {
  if (!serverSyncEnabled) return;
  const payload = {
    glossOptions: state.glossOptions,
    customers: state.customers,
    orders: state.orders,
    audits: state.audits,
    receivables: state.receivables,
    payables: state.payables,
    systemEvents: state.systemEvents.slice(0, 500),
    settings: state.settings,
    inventoryItems: state.inventoryItems,
    users: state.users,
    syncTick,
  };

  try {
    const res = await fetch(API_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      pendingSyncTick = 0;
      await pullServerState();
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（偵測到新版本資料，已自動同步）`, ok: false });
      return;
    }
    await readJsonOrThrow(res);
    pendingSyncTick = 0;
    lastSyncAt = Math.max(lastSyncAt, syncTick);
    setSyncUi('已儲存', fileModeOnly ? '本機儲存' : '集中式資料庫', syncTick);
  } catch (err) {
    pendingSyncTick = 0;
    if (!fileModeOnly) {
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（伺服器連線失敗：${err.message}）`, ok: false });
    }
  }
}

export async function pullServerState() {
  if (!serverSyncEnabled) return;
  try {
    const res = await fetch(API_STATE_URL, { cache: 'no-store' });
    const payload = await readJsonOrThrow(res);
    const tick = Number(payload.syncTick || payload.serverUpdatedAt || Date.now());
    if (pendingSyncTick && tick < pendingSyncTick) return;
    if (tick <= lastSyncAt) return;
    applyStatePayload(payload);
    normalizeStateData();
    localStorage.setItem('syncTick', String(tick));
    lastSyncAt = tick;
    onRefresh();
    setSyncUi('已收到伺服器資料', '集中式資料庫', tick);
  } catch (err) {
    if (!fileModeOnly) {
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（伺服器連線失敗：${err.message}）`, ok: false });
    }
  }
}

function uniqueById(rows) {
  const map = new Map();
  rows.forEach((item) => {
    if (!item || !item.id) return;
    map.set(item.id, item);
  });
  return [...map.values()];
}

function normalizeMoney(v) {
  const num = Number(v || 0);
  return Number.isFinite(num) ? Math.max(0, num) : 0;
}

function normalizeStateData() {
  state.customers = uniqueById(state.customers).map((c) => ({
    ...c,
    name: String(c.name || '').trim(),
    phone: String(c.phone || '').trim(),
    address: String(c.address || '').trim(),
  }));

  state.orders = uniqueById(state.orders).map((o) => ({
    ...o,
    orderNumber: String(o.orderNumber || '').trim(),
    upstream: String(o.upstream || '').trim(),
    downstream: String(o.downstream || '').trim(),
    address: String(o.address || '').trim(),
    totalPrice: normalizeMoney(o.totalPrice),
    sheetCount: Math.max(0, Number(o.sheetCount || 0)),
  }));

  state.receivables = uniqueById(state.receivables).map((r) => ({
    ...r,
    orderNumber: String(r.orderNumber || '').trim(),
    customer: String(r.customer || '').trim(),
    amount: normalizeMoney(r.amount),
    received: normalizeMoney(r.received),
  })).map((r) => ({ ...r, received: Math.min(r.received, r.amount) }));

  state.payables = uniqueById(state.payables).map((p) => ({
    ...p,
    vendor: String(p.vendor || '').trim(),
    item: String(p.item || '').trim(),
    amount: normalizeMoney(p.amount),
    paid: normalizeMoney(p.paid),
  })).map((p) => ({ ...p, paid: Math.min(p.paid, p.amount) }));

  state.audits = state.audits.slice(0, 5000);
  state.systemEvents = state.systemEvents.slice(0, 2000);
  state.inventoryItems = uniqueById(state.inventoryItems).map((item) => ({
    ...item,
    material: String(item.material || '').trim(),
    category: String(item.category || '').trim(),
    unit: String(item.unit || '').trim(),
    note: String(item.note || '').trim(),
    stock: normalizeMoney(item.stock),
    safetyStock: normalizeMoney(item.safetyStock),
  }));
  state.users = uniqueById(state.users).map((user) => ({
    ...user,
    username: String(user.username || '').trim(),
    password: String(user.password || ''),
    display: String(user.display || user.username || '').trim(),
    role: String(user.role || 'viewer').trim() || 'viewer',
  })).filter((user) => user.username && user.password);
  state.settings = mergeSettings(state.settings || {});
  state.financePassword = state.settings.financePassword;
}

export function getIntegrityReport() {
  const issues = [];
  const orderNumberSet = new Set();

  state.orders.forEach((o) => {
    const no = (o.orderNumber || '').trim();
    if (!no) issues.push({ level: 'warning', text: `有工單缺少編號（ID: ${o.id || '-'})` });
    if (no && orderNumberSet.has(no)) issues.push({ level: 'critical', text: `工單編號重複：${no}` });
    if (no) orderNumberSet.add(no);
    if (!o.address) issues.push({ level: 'info', text: `工單 ${no || o.id || '-'} 缺少地址` });
  });

  state.receivables.forEach((r) => {
    if (Number(r.received || 0) > Number(r.amount || 0)) {
      issues.push({ level: 'critical', text: `應收 ${r.orderNumber || r.id} 已收大於應收` });
    }
  });

  return {
    total: issues.length,
    critical: issues.filter((i) => i.level === 'critical').length,
    warning: issues.filter((i) => i.level === 'warning').length,
    info: issues.filter((i) => i.level === 'info').length,
    issues: issues.slice(0, 10),
  };
}

export function appendSystemEvent(message, level = 'info', meta = {}) {
  state.systemEvents.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    user: state.user || 'system',
    level,
    message,
    meta,
  });
  if (state.systemEvents.length > 2000) state.systemEvents.length = 2000;
}

export function saveState() {
  normalizeStateData();
  const now = Date.now();
  saveLocalState(now);
  if (fileModeOnly || !serverSyncEnabled) {
    lastSyncAt = now;
    setSyncUi('已儲存', '本機儲存', now);
    return;
  }
  pendingSyncTick = now;
  onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(now)}（資料送出中）`, ok: false });
  pushServerState(now);
}

export function configureStore({ refreshFn, syncUiFn }) {
  onRefresh = refreshFn;
  onSyncUi = syncUiFn;
}

export function initializeStore() {
  loadLocalState();
  normalizeStateData();
  const now = new Date();
  state.reportRange.start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  state.reportRange.end = now.toISOString().slice(0, 10);
  if (location.protocol === 'file:') {
    fileModeOnly = true;
    serverSyncEnabled = false;
    onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（本機檔案模式（請改用 start-lan.bat））`, ok: false });
  } else {
    onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Number(localStorage.getItem('syncTick') || 0))}（頁面載入）`, ok: false });
  }
}

export function startStoreSync() {
  window.addEventListener('storage', (e) => {
    if (STORAGE_KEYS.includes(e.key) || e.key === 'syncTick') {
      loadLocalState();
      onRefresh();
      const tick = Number(localStorage.getItem('syncTick') || Date.now());
      lastSyncAt = tick;
      setSyncUi('已收到最新資料', '跨分頁同步', tick);
    }
  });

  setInterval(() => {
    const tick = Number(localStorage.getItem('syncTick') || 0);
    if (tick > lastSyncAt) {
      loadLocalState();
      onRefresh();
      lastSyncAt = tick;
      setSyncUi('已收到最新資料', '跨分頁同步', tick);
    }
    pullServerState();
  }, 1500);
}

export function getOrderReceivableKey(order) {
  return (order.orderNumber || '').trim() || `ORDER-${order.id}`;
}

export function syncOrderToReceivables(order) {
  const key = getOrderReceivableKey(order);
  const idx = state.receivables.findIndex((r) => (r.orderNumber || '').trim() === key);
  const shouldLink = ['已完成', '已送出'].includes(order.status) && Number(order.totalPrice || 0) > 0;

  if (!shouldLink) {
    if (idx >= 0 && state.receivables[idx].source === 'auto-order') {
      state.receivables.splice(idx, 1);
    }
    return;
  }

  const linked = {
    id: idx >= 0 ? state.receivables[idx].id : crypto.randomUUID(),
    source: 'auto-order',
    date: order.orderDate || getTodayText(),
    customer: order.downstream || order.upstream || '-',
    orderNumber: key,
    amount: Number(order.totalPrice || 0),
    received: idx >= 0 ? Number(state.receivables[idx].received || 0) : 0,
  };

  if (idx >= 0) state.receivables[idx] = linked;
  else state.receivables.unshift(linked);
}
