import { $, COMPANY_INFO } from './shared.js';
import { applyUiSettings, bindSettingsEvents, renderSettings } from './settings.js';
import {
  state,
  configureStore,
  initializeStore,
  startStoreSync,
  saveState,
  pullServerState,
  getIntegrityReport,
  appendSystemEvent,
} from './store.js';
import { renderCustomers, renderCustomerOptions, bindCustomerEvents } from './customers.js';
import { renderOrders, renderOrderScreen, clearOrderForm, bindOrderEvents } from './orders.js';
import { renderFinance, bindFinanceEvents } from './finance.js';
import { renderAudits, bindAuditEvents } from './audit.js';
import { renderTrips, bindTripEvents } from './trips.js';
import { renderOpsCenter } from './ops-center.js';
import { renderInventory, bindInventoryEvents } from './inventory.js';
import { renderNotifications } from './notifications.js';

const APP_BUILD = '2026-03-18-enterprise-core-1';
const views = ['loginView', 'dashboardView', 'ordersView', 'customersView', 'tripsView', 'opsCenterView', 'inventoryView', 'notificationsView', 'financeView', 'auditView', 'settingsView'];
const REMINDER_LAST_SENT_AT_KEY = 'smartReminderLastSentAt';
const REMINDER_LAST_SCORE_KEY = 'smartReminderLastScore';
const REMINDER_LAST_SIGNATURE_KEY = 'smartReminderLastSignature';
let lastCriticalSignature = '';

const BUILTIN_ACCOUNTS = [
  { username: 'admin', password: 'admin123', role: 'admin', display: '系統管理員' },
  { username: 'ops', password: 'ops123', role: 'ops', display: '作業主管' },
  { username: 'finance', password: 'finance123', role: 'finance', display: '財務主管' },
  { username: 'audit', password: 'audit123', role: 'audit', display: '稽核主管' },
];

const ROLE_PERMS = {
  admin: ['dashboardView', 'ordersView', 'customersView', 'tripsView', 'opsCenterView', 'inventoryView', 'notificationsView', 'financeView', 'auditView'],
  ops: ['dashboardView', 'ordersView', 'customersView', 'tripsView', 'opsCenterView', 'inventoryView', 'notificationsView'],
  finance: ['dashboardView', 'financeView', 'notificationsView'],
  audit: ['dashboardView', 'auditView', 'notificationsView'],
  viewer: ['dashboardView', 'notificationsView'],
};

function setBuildVersion() {
  const el = $('buildVersion');
  if (el) el.textContent = `版本：${APP_BUILD}`;
}

function applySyncUi({ badgeText, detailText, ok }) {
  const badges = [$('syncBadge'), ...document.querySelectorAll('.sync-badge-global')].filter(Boolean);
  badges.forEach((b) => {
    b.textContent = badgeText;
    b.classList.toggle('ok', !!ok);
  });
  const detail = $('syncDetail');
  if (detail) detail.textContent = detailText;
  document.querySelectorAll('.sync-detail-global').forEach((el) => {
    el.textContent = detailText;
  });
}

function getRolePerms() {
  return ROLE_PERMS[state.userRole || 'viewer'] || ROLE_PERMS.viewer;
}

function isModuleEnabled(viewId) {
  if (!viewId || !viewId.endsWith('View') || viewId === 'settingsView' || viewId === 'dashboardView' || viewId === 'loginView') return true;
  return state.settings?.moduleEnabled?.[viewId] !== false;
}

function hasViewPermission(viewId) {
  if (viewId === 'loginView' || viewId === 'dashboardView' || viewId === 'settingsView') return true;
  if (!isModuleEnabled(viewId)) return false;
  if (state.settings?.openAccess) return true;
  return getRolePerms().includes(viewId);
}

function getAllAccounts() {
  return [...BUILTIN_ACCOUNTS, ...(state.users || [])];
}

function findAccountByUsername(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return null;
  return getAllAccounts().find((account) => String(account.username || '').trim().toLowerCase() === key) || null;
}

function findAccountByCredentials(username, password) {
  const account = findAccountByUsername(username);
  if (!account) return null;
  return account.password === password ? account : null;
}

function resetRegisterForm() {
  $('registerForm')?.reset();
}

function applyRoleUi() {
  document.querySelectorAll('.nav-card').forEach((card) => {
    const enabled = isModuleEnabled(card.dataset.target);
    const allowed = hasViewPermission(card.dataset.target);
    card.hidden = !enabled;
    card.disabled = !allowed;
    card.classList.toggle('is-locked', !allowed);
    card.classList.toggle('is-hidden-module', !enabled);
    card.title = !enabled ? '此模組已在設定中停用' : allowed ? '' : '目前帳號沒有此模組權限';
    card.style.opacity = allowed ? '1' : '0.5';
    card.style.cursor = allowed ? 'pointer' : 'not-allowed';
  });
}

function daysFrom(dateText) {
  if (!dateText) return 0;
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function buildSystemAlerts() {
  const alerts = [];
  const openOrders = state.orders.filter((o) => !['已完成', '已取消'].includes(o.status || '未完成'));

  const orderWarningDays = Number(state.settings?.orderWarningDays || 3);
  const receivableOverdueDays = Number(state.settings?.receivableOverdueDays || 30);
  const payableWarningDays = Number(state.settings?.payableWarningDays || 14);

  openOrders.filter((o) => daysFrom(o.orderDate) >= orderWarningDays).slice(0, 5)
    .forEach((o) => alerts.push({ level: 'warning', module: '工單', text: `工單 ${o.orderNumber || '-'} 已待處理 ${daysFrom(o.orderDate)} 天（門檻 ${orderWarningDays} 天）` }));

  openOrders.filter((o) => !o.address || Number(o.totalPrice || 0) <= 0).slice(0, 5)
    .forEach((o) => alerts.push({ level: 'info', module: '工單', text: `工單 ${o.orderNumber || '-'} 建議補齊${!o.address ? '地址' : ''}${!o.address && Number(o.totalPrice || 0) <= 0 ? '、' : ''}${Number(o.totalPrice || 0) <= 0 ? '總價' : ''}` }));

  state.receivables
    .map((r) => ({ ...r, remain: Math.max(0, Number(r.amount || 0) - Number(r.received || 0)) }))
    .filter((r) => r.remain > 0 && daysFrom(r.date) >= receivableOverdueDays).slice(0, 5)
    .forEach((r) => alerts.push({ level: 'critical', module: '財經', text: `應收逾期 ${daysFrom(r.date)} 天：${r.customer || '-'} / ${r.orderNumber || '-'} / 未收 ${r.remain.toLocaleString()}` }));

  state.payables
    .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }))
    .filter((p) => p.unpaid > 0 && daysFrom(p.date) >= payableWarningDays).slice(0, 5)
    .forEach((p) => alerts.push({ level: 'warning', module: '財經', text: `應付待付款：${p.vendor || '-'} / ${p.item || '-'} / 未付 ${p.unpaid.toLocaleString()}` }));

  const inactiveNames = new Set(state.customers.filter((c) => c.active === false).map((c) => (c.name || '').trim()));
  openOrders
    .filter((o) => inactiveNames.has((o.upstream || '').trim()) || inactiveNames.has((o.downstream || '').trim()))
    .slice(0, 5)
    .forEach((o) => alerts.push({ level: 'warning', module: '客戶', text: `工單 ${o.orderNumber || '-'} 使用了停用客戶` }));

  const inventoryWarnings = state.inventoryItems.filter((item) => Number(item.stock || 0) <= Number(item.safetyStock || 0));
  inventoryWarnings.slice(0, 5).forEach((item) => alerts.push({ level: 'warning', module: '庫存', text: `${item.material || '-'} 庫存偏低：${item.stock || 0} / 安全量 ${item.safetyStock || 0}` }));

  const today = new Date().toISOString().slice(0, 10);
  const priceChangesToday = state.audits.filter((a) => a.field === '總價' && String(a.changedAt || '').includes(today));
  if (priceChangesToday.length >= 3) alerts.push({ level: 'critical', module: '稽核', text: `今日總價異動 ${priceChangesToday.length} 筆` });

  const integrity = getIntegrityReport();
  if (integrity.critical > 0) alerts.push({ level: 'critical', module: '資料完整性', text: `完整性問題 ${integrity.critical} 筆` });

  return alerts;
}

function buildGlobalLineMessage(alerts) {
  const lines = alerts.length
    ? alerts.map((a) => `${a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟠' : '🔵'} [${a.module}] ${a.text}`)
    : ['✅ 目前全系統狀態正常'];
  return `【${COMPANY_INFO.name} 智能主動提醒】\n${COMPANY_INFO.address}\n時間：${new Date().toLocaleString()}\n\n${lines.join('\n')}`;
}

function getRiskScore(alerts) {
  return alerts.reduce((sum, a) => sum + (a.level === 'critical' ? 4 : a.level === 'warning' ? 2 : 1), 0);
}

function pushGlobalLineReminder(alerts) {
  const text = buildGlobalLineMessage(alerts);
  const url = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
  const score = getRiskScore(alerts);
  const signature = alerts.map((a) => `${a.level}|${a.module}|${a.text}`).join('\n');
  localStorage.setItem(REMINDER_LAST_SENT_AT_KEY, String(Date.now()));
  localStorage.setItem(REMINDER_LAST_SCORE_KEY, String(score));
  localStorage.setItem(REMINDER_LAST_SIGNATURE_KEY, signature);
  appendSystemEvent(`已自動推送智能提醒（風險分數 ${score}）`, 'warning', { score, count: alerts.length });
  saveState();
}

function shouldAutoPush(alerts) {
  if (!alerts.length) return false;
  const now = Date.now();
  const lastSentAt = Number(localStorage.getItem(REMINDER_LAST_SENT_AT_KEY) || 0);
  const elapsedMin = (now - lastSentAt) / 60000;
  const lastScore = Number(localStorage.getItem(REMINDER_LAST_SCORE_KEY) || 0);
  const score = getRiskScore(alerts);
  const signature = alerts.map((a) => `${a.level}|${a.module}|${a.text}`).join('\n');
  const lastSignature = localStorage.getItem(REMINDER_LAST_SIGNATURE_KEY) || '';

  const criticalSignature = alerts.filter((a) => a.level === 'critical').map((a) => `${a.module}|${a.text}`).join('\n');
  const hasNewCritical = criticalSignature && criticalSignature !== lastCriticalSignature;

  if (hasNewCritical && elapsedMin >= 2) return true;
  if (score >= 12 && score - lastScore >= 4 && elapsedMin >= 10) return true;
  if (score >= 7 && signature !== lastSignature && elapsedMin >= 30) return true;
  return false;
}

function proactiveNotify() {
  const alerts = buildSystemAlerts();
  const critical = alerts.filter((a) => a.level === 'critical');
  const criticalSignature = critical.map((a) => `${a.module}|${a.text}`).join('\n');

  if (critical.length && criticalSignature !== lastCriticalSignature) {
    lastCriticalSignature = criticalSignature;
    alert(`【企業級主動提醒】偵測到 ${critical.length} 項關鍵風險，系統將評估並自動通知。`);
  }

  if (shouldAutoPush(alerts)) pushGlobalLineReminder(alerts);
  return alerts;
}

function renderDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.orders.filter((o) => (o.orderDate || '').slice(0, 10) === today).length;
  const pending = state.orders.filter((o) => (o.status || '未完成') !== '已完成').length;
  const recvOutstanding = state.receivables.reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0) - Number(r.received || 0)), 0);
  const inventoryWarnings = state.inventoryItems.filter((item) => Number(item.stock || 0) <= Number(item.safetyStock || 0));
  const topCustomer = Object.entries(state.orders.reduce((acc, o) => {
    const c = (o.downstream || o.upstream || '').trim();
    if (!c) return acc;
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];

  if ($('dashTodayOrders')) $('dashTodayOrders').textContent = String(todayCount);
  if ($('dashPendingOrders')) $('dashPendingOrders').textContent = String(pending);

  const alerts = proactiveNotify();
  const integrity = getIntegrityReport();
  const tip = $('dashboardSmartTip');
  if (tip) {
    const customerText = topCustomer ? `熱度最高客戶：${topCustomer[0]}（${topCustomer[1]} 筆）` : '尚無客戶熱度資料';
    const riskText = alerts.length ? `智能提醒 ${alerts.length} 筆（風險 ${getRiskScore(alerts)}）` : '智能提醒 0 筆';
    tip.textContent = `智能總覽：待處理工單 ${pending} 筆，應收未收約 NT$ ${recvOutstanding.toLocaleString()}。${customerText}｜低庫存 ${inventoryWarnings.length} 項｜資料完整性 C:${integrity.critical}/W:${integrity.warning}｜${riskText}｜${COMPANY_INFO.name}`;
  }

  applyRoleUi();
}

function renderAll() {
  applyUiSettings(state);
  renderDashboard();
  renderCustomers(state);
  renderOrders(state, renderCustomerOptions);
  renderAudits(state);
  renderFinance(state);
  renderOrderScreen(state);
  renderTrips(state);
  renderOpsCenter(state);
  renderInventory(state);
  renderNotifications(state);
  renderSettings(state);
}

function showView(id) {
  if (id !== 'loginView' && !state.user) {
    alert('請先登入系統。');
    return;
  }
  if (id !== 'loginView' && !hasViewPermission(id)) {
    appendSystemEvent(`權限拒絕：嘗試進入 ${id}`, 'warning', { role: state.userRole || 'viewer' });
    saveState();
    alert('此帳號沒有此模組權限。');
    return;
  }
  views.forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
  if (id === 'ordersView') {
    state.orderScreen = 'list';
    renderOrderScreen(state);
  }
  renderAll();
}

function openFinanceGate() {
  if (!hasViewPermission('financeView')) return alert(isModuleEnabled('financeView') ? '此帳號沒有財經模組權限。' : '財經模組目前已停用。');
  if (state.settings?.openAccess || !state.settings?.financeGateEnabled) return showView('financeView');
  const dialog = $('financeDialog');
  if (dialog && typeof dialog.showModal === 'function') return dialog.showModal();
  const input = window.prompt('請輸入財經系統密碼');
  if (input === null) return;
  if (input !== state.financePassword) return alert('密碼錯誤');
  showView('financeView');
}

function bindCoreEvents() {
  $('loginForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) return alert('請輸入帳號與密碼');
<<<<<< codex-d2sdch
    const account = findAccountByCredentials(username, password);
    if (!account) return alert('帳號不存在或密碼錯誤，請先註冊或確認登入資訊');

    state.user = account.display || account.username;
    state.userRole = account.role || 'viewer';
=======
    const account = ACCOUNTS.find((a) => a.username === username && a.password === password);
    if (!account && ACCOUNTS.some((a) => a.username === username)) return alert('帳號或密碼錯誤');

    const effectiveAccount = account || { role: 'admin', display: username };
    state.user = effectiveAccount.display;
    state.userRole = effectiveAccount.role;
>>>>>> main
    const prefix = state.settings?.welcomePrefix || '你好';
    $('welcomeText').textContent = `${prefix}，${state.user}（${state.userRole}）`;
    appendSystemEvent(`使用者登入：${state.user}`, 'info', { role: state.userRole });
    saveState();
    const landing = state.settings?.defaultLandingView || 'dashboardView';
    showView(hasViewPermission(landing) ? landing : 'dashboardView');
  });

  $('registerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const display = $('registerDisplay')?.value.trim();
    const username = $('registerUsername')?.value.trim();
    const password = $('registerPassword')?.value || '';
    const confirmPassword = $('registerConfirmPassword')?.value || '';

    if (!display || !username || !password || !confirmPassword) return alert('請完整填寫註冊資料');
    if (username.length < 3) return alert('帳號至少需要 3 碼');
    if (password.length < 4) return alert('密碼至少需要 4 碼');
    if (password !== confirmPassword) return alert('兩次輸入的密碼不一致');
    if (findAccountByUsername(username)) return alert('此帳號已存在，請改用其他帳號名稱');

    state.users.unshift({
      id: crypto.randomUUID(),
      username,
      password,
      display,
      role: 'viewer',
      createdAt: new Date().toISOString(),
    });
    appendSystemEvent(`新帳號註冊：${display}`, 'info', { username, role: 'viewer' });
    saveState();
    $('username').value = username;
    $('password').value = password;
    resetRegisterForm();
    alert('註冊成功，現在可以直接登入。');
  });

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open-view]');
    if (!opener) return;
    showView(opener.dataset.openView);
  });

  $('logoutBtn')?.addEventListener('click', () => {
    appendSystemEvent(`使用者登出：${state.user || 'unknown'}`, 'info', { role: state.userRole || 'viewer' });
    saveState();
    state.user = null;
    state.userRole = 'viewer';
    showView('loginView');
  });

  document.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => showView('dashboardView')));

  document.querySelectorAll('.nav-card').forEach((card) => {
    card.addEventListener('click', () => {
      const target = card.dataset.target;
      if (target === 'financeView') return openFinanceGate();
      showView(target);
    });
  });

  $('financeForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('financePassword').value !== state.financePassword) return alert('密碼錯誤');
    $('financePassword').value = '';
    $('financeDialog').close();
    showView('financeView');
  });

  $('cancelFinanceBtn')?.addEventListener('click', () => {
    $('financePassword').value = '';
    $('financeDialog').close();
  });

  window.addEventListener('keydown', (e) => {
    if (!state.settings?.enableKeyboardShortcut) return;
    if (e.key.toLowerCase() === 'a' && !$('dashboardView').classList.contains('hidden')) showView('auditView');
  });
}

function bootstrapFailed(err) {
  console.error(err);
  const message = `系統初始化失敗：${err?.message || err}`;
  if ($('appLoginMessage')) $('appLoginMessage').textContent = message;
  if ($('buildVersion')) $('buildVersion').textContent = '版本：初始化失敗';
  $('loginForm')?.addEventListener('submit', (e) => {
    if (window.__appBootstrapped) return;
    e.preventDefault();
    alert(`${message}\n請先按 Ctrl + F5 強制重新整理；若仍失敗，再檢查 /api/health。`);
  });
  $('registerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    alert(`${message}\n目前無法註冊新帳號，請先恢復系統連線後再試。`);
  });
}

try {
  configureStore({ refreshFn: renderAll, syncUiFn: applySyncUi });
  setBuildVersion();
  initializeStore();
  clearOrderForm();
  bindCoreEvents();
  bindCustomerEvents(state, saveState, renderAll);
  bindOrderEvents(state, saveState, renderAll);
  bindFinanceEvents(state, saveState, renderAll);
  bindAuditEvents(state);
  bindTripEvents(state, saveState, renderAll);
  bindInventoryEvents(state, saveState, renderAll);
  bindSettingsEvents(state, saveState, renderAll);
  renderAll();
  window.__appBootstrapped = true;
  showView('loginView');
  startStoreSync();
  pullServerState();

  setInterval(() => {
    if (!$('dashboardView')?.classList.contains('hidden')) renderDashboard();
  }, 60000);
} catch (err) {
  bootstrapFailed(err);
}
