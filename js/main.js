import { $ } from './shared.js';
import { state, configureStore, initializeStore, startStoreSync, saveState, pullServerState } from './store.js';
import { renderCustomers, renderCustomerOptions, bindCustomerEvents } from './customers.js';
import { renderOrders, renderOrderScreen, clearOrderForm, bindOrderEvents } from './orders.js';
import { renderFinance, bindFinanceEvents } from './finance.js';
import { renderAudits, bindAuditEvents } from './audit.js';
import { renderTrips, bindTripEvents } from './trips.js';

const APP_BUILD = '2026-03-07-trip-and-finance-dashboard-1';
const views = ['loginView', 'dashboardView', 'ordersView', 'customersView', 'tripsView', 'financeView', 'auditView'];

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

function renderDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.orders.filter((o) => (o.orderDate || '').slice(0, 10) === today).length;
  const pending = state.orders.filter((o) => (o.status || '未完成') !== '已完成').length;
  if ($('dashTodayOrders')) $('dashTodayOrders').textContent = String(todayCount);
  if ($('dashPendingOrders')) $('dashPendingOrders').textContent = String(pending);
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
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
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

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showView('dashboardView'));
  });

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
