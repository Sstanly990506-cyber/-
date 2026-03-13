import { formatTs, getTodayText } from './shared.js';

const STORAGE_KEYS = ['glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables'];
const DEFAULT_STATE_PAYLOAD = {
  glossOptions: ['PVA光', 'PVB光/油', '耐磨', '壓光'],
  customers: [],
  orders: [],
  audits: [],
  receivables: [],
  payables: [],
};
const API_STATE_URL = '/api/state';

export const state = {
  user: null,
  financePassword: '123',
  glossOptions: [],
  customers: [],
  orders: [],
  audits: [],
  receivables: [],
  payables: [],
  reportRange: { start: '', end: '' },
  financeScreen: 'main',
  auditFilter: { start: '', end: '', keyword: '' },
  orderStatusFilter: '全部',
  orderScreen: 'list',
};

let lastSyncAt = 0;
let serverSyncEnabled = true;
let fileModeOnly = false;
let onRefresh = () => {};
let onSyncUi = () => {};

function applyStatePayload(payload) {
  STORAGE_KEYS.forEach((key) => {
    state[key] = payload[key] || DEFAULT_STATE_PAYLOAD[key];
  });
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadLocalState() {
  const payload = {};
  STORAGE_KEYS.forEach((key) => {
    const fallback = DEFAULT_STATE_PAYLOAD[key];
    payload[key] = safeJsonParse(localStorage.getItem(key) || JSON.stringify(fallback), fallback);
  });
  applyStatePayload(payload);
}

function saveLocalState(now) {
  STORAGE_KEYS.forEach((key) => {
    localStorage.setItem(key, JSON.stringify(state[key]));
  });
  localStorage.setItem('syncTick', String(now));
}

function setSyncUi(badgeText, source, ts = Date.now()) {
  onSyncUi({ badgeText, detailText: `最後更新：${formatTs(ts)}（${source}）`, ok: true });
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
    syncTick,
  };

  try {
    const res = await fetch(API_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      await pullServerState();
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（偵測到新版本資料，已自動同步）`, ok: false });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    if (!fileModeOnly) {
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（伺服器連線失敗（重試中））`, ok: false });
    }
  }
}

export async function pullServerState() {
  if (!serverSyncEnabled) return;
  try {
    const res = await fetch(API_STATE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const tick = Number(payload.syncTick || payload.serverUpdatedAt || Date.now());
    if (tick <= lastSyncAt) return;
    applyStatePayload(payload);
    localStorage.setItem('syncTick', String(tick));
    lastSyncAt = tick;
    onRefresh();
    setSyncUi('已收到伺服器資料', '集中式資料庫', tick);
  } catch {
    if (!fileModeOnly) {
      onSyncUi({ badgeText: '同步中', detailText: `最後更新：${formatTs(Date.now())}（伺服器連線失敗（重試中））`, ok: false });
    }
  }
}

export function saveState() {
  const now = Date.now();
  saveLocalState(now);
  lastSyncAt = now;
  pushServerState(now);
  setSyncUi('已儲存', fileModeOnly ? '本機儲存' : '集中式資料庫', now);
}

export function configureStore({ refreshFn, syncUiFn }) {
  onRefresh = refreshFn;
  onSyncUi = syncUiFn;
}

export function initializeStore() {
  loadLocalState();
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
