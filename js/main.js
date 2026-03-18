import { $, COMPANY_INFO } from './shared.js';
import { state, configureStore, initializeStore, startStoreSync, saveState, pullServerState } from './store.js';
import { renderCustomers, renderCustomerOptions, bindCustomerEvents } from './customers.js';
import { renderOrders, renderOrderScreen, clearOrderForm, bindOrderEvents } from './orders.js';
import { renderFinance, bindFinanceEvents } from './finance.js';
import { renderAudits, bindAuditEvents } from './audit.js';
import { renderTrips, bindTripEvents } from './trips.js';

const APP_BUILD = '2026-03-17-smart-event-driven-reminder-1';
const views = ['loginView', 'dashboardView', 'ordersView', 'customersView', 'tripsView', 'financeView', 'auditView'];
const REMINDER_LAST_SENT_AT_KEY = 'smartReminderLastSentAt';
const REMINDER_LAST_SCORE_KEY = 'smartReminderLastScore';
const REMINDER_LAST_SIGNATURE_KEY = 'smartReminderLastSignature';
let lastCriticalSignature = '';

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

function daysFrom(dateText) {
  if (!dateText) return 0;
  const d = new Date(dateText);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function buildSystemAlerts() {
  const alerts = [];
  const openOrders = state.orders.filter((o) => !['已完成', '已取消'].includes(o.status || '未完成'));

  openOrders.filter((o) => daysFrom(o.orderDate) >= 3).slice(0, 5)
    .forEach((o) => alerts.push({ level: 'warning', module: '工單', text: `工單 ${o.orderNumber || '-'} 已待處理 ${daysFrom(o.orderDate)} 天` }));

  openOrders.filter((o) => !o.address || Number(o.totalPrice || 0) <= 0).slice(0, 5)
    .forEach((o) => alerts.push({ level: 'info', module: '工單', text: `工單 ${o.orderNumber || '-'} 建議補齊${!o.address ? '地址' : ''}${!o.address && Number(o.totalPrice || 0) <= 0 ? '、' : ''}${Number(o.totalPrice || 0) <= 0 ? '總價' : ''}` }));

  state.receivables
    .map((r) => ({ ...r, remain: Math.max(0, Number(r.amount || 0) - Number(r.received || 0)) }))
    .filter((r) => r.remain > 0 && daysFrom(r.date) >= 30).slice(0, 5)
    .forEach((r) => alerts.push({ level: 'critical', module: '財經', text: `應收逾期 ${daysFrom(r.date)} 天：${r.customer || '-'} / ${r.orderNumber || '-'} / 未收 ${r.remain.toLocaleString()}` }));

  state.payables
    .map((p) => ({ ...p, unpaid: Math.max(0, Number(p.amount || 0) - Number(p.paid || 0)) }))
    .filter((p) => p.unpaid > 0 && daysFrom(p.date) >= 14).slice(0, 5)
    .forEach((p) => alerts.push({ level: 'warning', module: '財經', text: `應付待付款：${p.vendor || '-'} / ${p.item || '-'} / 未付 ${p.unpaid.toLocaleString()}` }));

  const inactiveNames = new Set(state.customers.filter((c) => c.active === false).map((c) => (c.name || '').trim()));
  openOrders
    .filter((o) => inactiveNames.has((o.upstream || '').trim()) || inactiveNames.has((o.downstream || '').trim()))
    .slice(0, 5)
    .forEach((o) => alerts.push({ level: 'warning', module: '客戶', text: `工單 ${o.orderNumber || '-'} 使用了停用客戶，建議檢查` }));

  const today = new Date().toISOString().slice(0, 10);
  const priceChangesToday = state.audits.filter((a) => a.field === '總價' && String(a.changedAt || '').includes(today));
  if (priceChangesToday.length >= 3) alerts.push({ level: 'critical', module: '稽核', text: `今日總價異動 ${priceChangesToday.length} 筆，建議立即複核` });

  return alerts;
}

function buildGlobalLineMessage(alerts) {
  const lines = alerts.length
    ? alerts.map((a) => `${a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟠' : '🔵'} [${a.module}] ${a.text}`)
    : ['✅ 目前全系統狀態正常'];
  return `【${COMPANY_INFO.name} 智能主動提醒】\n${COMPANY_INFO.address}\n時間：${new Date().toLocaleString()}\n\n${lines.join('\n')}`;
}

function pushGlobalLineReminder(alerts) {
  const text = buildGlobalLineMessage(alerts);
  const url = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
  localStorage.setItem(REMINDER_LAST_SENT_AT_KEY, String(Date.now()));
  localStorage.setItem(REMINDER_LAST_SIGNATURE_KEY, alerts.map((a) => `${a.level}|${a.module}|${a.text}`).join('\n'));
  localStorage.setItem(REMINDER_LAST_SCORE_KEY, String(getRiskScore(alerts)));
}

function getRiskScore(alerts) {
  return alerts.reduce((sum, a) => sum + (a.level === 'critical' ? 4 : a.level === 'warning' ? 2 : 1), 0);
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
  if (score >= 10 && score - lastScore >= 4 && elapsedMin >= 10) return true;
  if (score >= 6 && signature !== lastSignature && elapsedMin >= 30) return true;
  return false;
}

function proactiveNotify() {
  const alerts = buildSystemAlerts();
  const critical = alerts.filter((a) => a.level === 'critical');
  const criticalSignature = critical.map((a) => `${a.module}|${a.text}`).join('\n');

  if (critical.length && criticalSignature !== lastCriticalSignature) {
    lastCriticalSignature = criticalSignature;
    alert(`【主動提醒】偵測到 ${critical.length} 項關鍵事件，系統將評估是否自動推送 LINE。`);
  }

  if (shouldAutoPush(alerts)) pushGlobalLineReminder(alerts);

  return alerts;
}

function renderDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.orders.filter((o) => (o.orderDate || '').slice(0, 10) === today).length;
  const pending = state.orders.filter((o) => (o.status || '未完成') !== '已完成').length;
  const recvOutstanding = state.receivables.reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0) - Number(r.received || 0)), 0);
  const topCustomer = Object.entries(state.orders.reduce((acc, o) => {
    const c = (o.downstream || o.upstream || '').trim();
    if (!c) return acc;
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];

  if ($('dashTodayOrders')) $('dashTodayOrders').textContent = String(todayCount);
  if ($('dashPendingOrders')) $('dashPendingOrders').textContent = String(pending);

  const alerts = proactiveNotify();
  const tip = $('dashboardSmartTip');
  if (tip) {
    const customerText = topCustomer ? `熱度最高客戶：${topCustomer[0]}（${topCustomer[1]} 筆）` : '尚無客戶熱度資料';
    const riskText = alerts.length ? `智能提醒 ${alerts.length} 筆（風險分數 ${getRiskScore(alerts)}）` : '智能提醒 0 筆';
    tip.textContent = `智能總覽：待處理工單 ${pending} 筆，應收未收約 NT$ ${recvOutstanding.toLocaleString()}。${customerText}｜${riskText}｜${COMPANY_INFO.name}`;
  }
}

function renderAll() {
  renderDashboard();
  renderCustomers(state);
  renderOrders(state, renderCustomerOptions);
  renderAudits(state);
  renderFinance(state);
  renderOrderScreen(state);
  renderTrips(state);
}

function showView(id) {
  views.forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
  if (id === 'ordersView') {
    state.orderScreen = 'list';
    renderOrderScreen(state);
  }
  renderAll();
}

function openFinanceGate() {
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
    state.user = $('username').value.trim();
    $('welcomeText').textContent = `你好，${state.user}`;
    showView('dashboardView');
  });

  $('logoutBtn')?.addEventListener('click', () => {
    state.user = null;
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
    if (e.key.toLowerCase() === 'a' && !$('dashboardView').classList.contains('hidden')) showView('auditView');
  });
}

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
renderAll();
showView('loginView');
startStoreSync();
pullServerState();

setInterval(() => {
  if (!$('dashboardView')?.classList.contains('hidden')) renderDashboard();
}, 60000);
