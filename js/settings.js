import { $, MODULE_DEFINITIONS, applyRuntimeBranding, getDefaultSettings, getModuleMeta, mergeSettings, isModuleEnabledInSettings } from './shared.js';

function ensureSettings(state) {
  state.settings = mergeSettings(state.settings || {});
  return state.settings;
}

function moduleSettingsHtml(settings) {
  return MODULE_DEFINITIONS.map((module) => {
    const label = settings.moduleLabels[module.id] || module.label;
    const description = settings.moduleDescriptions[module.id] || module.description;
    const icon = settings.moduleIcons[module.id] || module.icon;
    const pageNote = settings.modulePageNotes[module.id] || `${label} 的頁面說明`;
    const enabled = isModuleEnabledInSettings(settings, module.id);
    return `
      <label class="settings-module-card">
        <div class="settings-module-head">
          <div>
            <strong>${icon} ${label}</strong>
            <p class="sub">${description}</p>
          </div>
          <span class="toggle-pill ${enabled ? 'on' : 'off'}">${enabled ? '啟用中' : '已停用'}</span>
        </div>
        <div class="form-grid module-form-grid">
          <label>圖示<input data-settings-module-icon="${module.id}" value="${icon}" maxlength="4" /></label>
          <label>名稱<input data-settings-module-label="${module.id}" value="${label}" placeholder="模組名稱" /></label>
          <label class="span-2">描述<input data-settings-module-description="${module.id}" value="${description}" placeholder="模組說明" /></label>
          <label class="span-2">頁面說明<input data-settings-module-page-note="${module.id}" value="${pageNote}" placeholder="模組頁面內說明" /></label>
        </div>
        <span class="check-row">
          <input data-settings-module-enabled="${module.id}" type="checkbox" ${enabled ? 'checked' : ''} />
          顯示並開放此模組
        </span>
      </label>`;
  }).join('');
}

const PERMISSION_ROLE_DEFAULTS = {
  admin: MODULE_DEFINITIONS.map((module) => module.id),
  ops: ['ordersView', 'customersView', 'tripsView', 'opsCenterView', 'inventoryView', 'notificationsView'],
  finance: ['financeView', 'notificationsView'],
  audit: ['auditView', 'notificationsView'],
  driver: ['tripsView'],
  viewer: ['notificationsView'],
};
const PERMISSION_ROLES = [
  ['ops', '作業人員'],
  ['finance', '財經人員'],
  ['audit', '稽核人員'],
  ['driver', '司機'],
  ['viewer', '唯讀人員'],
  ['admin', '管理員'],
];
const PERMISSION_MODULES = MODULE_DEFINITIONS.filter((module) => !['loginView', 'dashboardView', 'settingsView'].includes(module.id));
const CAPACITY_LABELS = {
  orders: '工單',
  customers: '客戶',
  receivables: '應收款',
  payables: '應付款',
  inventory: '庫存',
  audits: '稽核紀錄',
  events: '通知事件',
  aiCorrections: 'AI 修正',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function defaultViewsForRole(role) {
  return PERMISSION_ROLE_DEFAULTS[role] || PERMISSION_ROLE_DEFAULTS.viewer;
}

function renderPermissionChecks(container, selected = []) {
  if (!container) return;
  const selectedSet = new Set(selected);
  container.innerHTML = PERMISSION_MODULES.map((module) => {
    const label = escapeHtml(module.label);
    return `<label class="permission-chip"><input type="checkbox" value="${module.id}" ${selectedSet.has(module.id) ? 'checked' : ''} /> ${label}</label>`;
  }).join('');
}

function selectedPermissionViews(container) {
  return [...(container?.querySelectorAll('input[type="checkbox"]:checked') || [])].map((input) => input.value);
}

function roleOptionsHtml(selectedRole) {
  return PERMISSION_ROLES.map(([value, label]) => `<option value="${value}" ${value === selectedRole ? 'selected' : ''}>${label}</option>`).join('');
}

function accountPermissionHtml(account) {
  const allowed = new Set(account.allowedViews || defaultViewsForRole(account.role));
  const checks = PERMISSION_MODULES.map((module) => (
    `<label class="permission-chip"><input data-account-module type="checkbox" value="${module.id}" ${allowed.has(module.id) ? 'checked' : ''} /> ${escapeHtml(module.label)}</label>`
  )).join('');
  return `
    <div class="account-permission-card" data-account-permission-row="${escapeHtml(account.id || account.username)}">
      <div>
        <strong>${escapeHtml(account.display || account.username)}</strong>
        <p class="sub">${escapeHtml(account.username)}｜${escapeHtml(account.role || 'viewer')}</p>
      </div>
      <label>角色
        <select data-account-role>${roleOptionsHtml(account.role || 'viewer')}</select>
      </label>
      <div class="module-permission-grid">${checks}</div>
      <button class="btn small" type="button" data-save-account-permissions>儲存權限</button>
    </div>`;
}

function renderCapacity(payload) {
  const summary = $('capacitySummary');
  const metrics = $('capacityMetrics');
  const warnings = $('capacityWarnings');
  if (!summary || !metrics || !warnings) return;
  const statusText = payload.status === 'ok' ? '正常' : payload.status === 'watch' ? '需觀察' : '有錯誤';
  const queryText = payload.countMs != null ? `｜批次查詢 ${Number(payload.countMs || 0).toLocaleString()} ms` : '';
  summary.textContent = `${statusText}｜${payload.storageMode || '-'}｜總資料 ${Number(payload.totalRecords || 0).toLocaleString()} 筆${queryText}｜檢測 ${new Date(Number(payload.checkedAt || Date.now())).toLocaleString()}`;
  metrics.innerHTML = Object.entries(payload.counts || {}).map(([entity, count]) => `<div class="kpi"><span>${CAPACITY_LABELS[entity] || entity}</span><strong>${Number(count || 0).toLocaleString()}</strong><small>已批次檢測</small></div>`).join('');
  const lines = [...(payload.warnings || [])];
  Object.entries(payload.errors || {}).forEach(([entity, message]) => lines.push(`${CAPACITY_LABELS[entity] || entity} 檢測失敗：${message}`));
  warnings.innerHTML = lines.length ? lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('') : '<li>目前沒有明顯容量警訊。</li>';
}
function fillForm(settings) {
  const map = {
    settingsAppTitle: settings.appTitle,
    settingsLoginTitle: settings.loginTitle,
    settingsCompanyName: settings.companyName,
    settingsCompanyAddress: settings.companyAddress,
    settingsCompanyPhone: settings.companyPhone,
    settingsCompanyIndustry: settings.companyIndustry,
    settingsCompanyEmail: settings.companyEmail,
    settingsCompanyWebsite: settings.companyWebsite,
    settingsCompanyTaxId: settings.companyTaxId,
    settingsLoginMessage: settings.loginMessage,
    settingsDashboardHeroTitle: settings.dashboardHeroTitle,
    settingsDashboardHeroSubtitle: settings.dashboardHeroSubtitle,
    settingsDashboardAnnouncement: settings.dashboardAnnouncement,
    settingsWelcomePrefix: settings.welcomePrefix,
    settingsThemePrimary: settings.themePrimary,
    settingsThemeAccent: settings.themeAccent,
    settingsThemePanel: settings.themePanel,
    settingsOrderWarningDays: settings.orderWarningDays,
    settingsReceivableOverdueDays: settings.receivableOverdueDays,
    settingsPayableWarningDays: settings.payableWarningDays,
    settingsInventoryLowStockDefault: settings.inventoryLowStockDefault,
    settingsDefaultLandingView: settings.defaultLandingView,
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = $(id);
    if (el) el.value = value;
  });
  if ($('settingsOpenAccess')) $('settingsOpenAccess').checked = !!settings.openAccess;
  if ($('settingsOrderShowFilters')) $('settingsOrderShowFilters').checked = !!settings.moduleInternals.orders.showFilters;
  if ($('settingsOrderShowExport')) $('settingsOrderShowExport').checked = !!settings.moduleInternals.orders.showExport;
  if ($('settingsOrderStatusPending')) $('settingsOrderStatusPending').checked = !!settings.moduleInternals.orders.statuses['未完成'];
  if ($('settingsOrderStatusSent')) $('settingsOrderStatusSent').checked = !!settings.moduleInternals.orders.statuses['已送出'];
  if ($('settingsOrderStatusDone')) $('settingsOrderStatusDone').checked = !!settings.moduleInternals.orders.statuses['已完成'];
  if ($('settingsOrderQuickSent')) $('settingsOrderQuickSent').checked = !!settings.moduleInternals.orders.quickActions['已送出'];
  if ($('settingsOrderQuickDone')) $('settingsOrderQuickDone').checked = !!settings.moduleInternals.orders.quickActions['已完成'];
  if ($('settingsCustomerRoleUpstream')) $('settingsCustomerRoleUpstream').checked = !!settings.moduleInternals.customers.roles['上游'];
  if ($('settingsCustomerRoleDownstream')) $('settingsCustomerRoleDownstream').checked = !!settings.moduleInternals.customers.roles['下游'];
  if ($('settingsCustomerRoleBoth')) $('settingsCustomerRoleBoth').checked = !!settings.moduleInternals.customers.roles['兩者'];
  if ($('settingsTripTypeDelivery')) $('settingsTripTypeDelivery').checked = !!settings.moduleInternals.trips.stopTypes.delivery;
  if ($('settingsTripTypePickup')) $('settingsTripTypePickup').checked = !!settings.moduleInternals.trips.stopTypes.pickup;
  if ($('settingsTripShowManualStopForm')) $('settingsTripShowManualStopForm').checked = !!settings.moduleInternals.trips.showManualStopForm;
  if ($('settingsTripShowOrderPool')) $('settingsTripShowOrderPool').checked = !!settings.moduleInternals.trips.showOrderPool;
  if ($('settingsTripShowManualRoute')) $('settingsTripShowManualRoute').checked = !!settings.moduleInternals.trips.showManualRoute;
  if ($('settingsEnableKeyboardShortcut')) $('settingsEnableKeyboardShortcut').checked = !!settings.enableKeyboardShortcut;
  if ($('settingsModulesList')) $('settingsModulesList').innerHTML = moduleSettingsHtml(settings);
  updateSettingsPreview(settings);
}

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
}

function collectSettings() {
  const defaults = getDefaultSettings();
  const next = mergeSettings({
    appTitle: $('settingsAppTitle')?.value.trim() || defaults.appTitle,
    loginTitle: $('settingsLoginTitle')?.value.trim() || defaults.loginTitle,
    companyName: $('settingsCompanyName')?.value.trim() || defaults.companyName,
    companyAddress: $('settingsCompanyAddress')?.value.trim() || defaults.companyAddress,
    companyPhone: $('settingsCompanyPhone')?.value.trim() || defaults.companyPhone,
    companyIndustry: $('settingsCompanyIndustry')?.value.trim() || defaults.companyIndustry,
    companyEmail: $('settingsCompanyEmail')?.value.trim() || defaults.companyEmail,
    companyWebsite: $('settingsCompanyWebsite')?.value.trim() || defaults.companyWebsite,
    companyTaxId: $('settingsCompanyTaxId')?.value.trim() || defaults.companyTaxId,
    loginMessage: $('settingsLoginMessage')?.value.trim() || defaults.loginMessage,
    dashboardHeroTitle: $('settingsDashboardHeroTitle')?.value.trim() || defaults.dashboardHeroTitle,
    dashboardHeroSubtitle: $('settingsDashboardHeroSubtitle')?.value.trim() || defaults.dashboardHeroSubtitle,
    dashboardAnnouncement: $('settingsDashboardAnnouncement')?.value.trim() || defaults.dashboardAnnouncement,
    welcomePrefix: $('settingsWelcomePrefix')?.value.trim() || defaults.welcomePrefix,
    defaultLandingView: $('settingsDefaultLandingView')?.value || defaults.defaultLandingView,
    themePrimary: $('settingsThemePrimary')?.value || defaults.themePrimary,
    themeAccent: $('settingsThemeAccent')?.value || defaults.themeAccent,
    themePanel: $('settingsThemePanel')?.value || defaults.themePanel,
    openAccess: !!$('settingsOpenAccess')?.checked,
    enableKeyboardShortcut: !!$('settingsEnableKeyboardShortcut')?.checked,
    orderWarningDays: toPositiveInt($('settingsOrderWarningDays')?.value, defaults.orderWarningDays),
    receivableOverdueDays: toPositiveInt($('settingsReceivableOverdueDays')?.value, defaults.receivableOverdueDays),
    payableWarningDays: toPositiveInt($('settingsPayableWarningDays')?.value, defaults.payableWarningDays),
    inventoryLowStockDefault: toPositiveInt($('settingsInventoryLowStockDefault')?.value, defaults.inventoryLowStockDefault),
    moduleInternals: {
      orders: {
        showFilters: !!$('settingsOrderShowFilters')?.checked,
        showExport: !!$('settingsOrderShowExport')?.checked,
        statuses: {
          '未完成': !!$('settingsOrderStatusPending')?.checked,
          '已送出': !!$('settingsOrderStatusSent')?.checked,
          '已完成': !!$('settingsOrderStatusDone')?.checked,
        },
        quickActions: {
          '已送出': !!$('settingsOrderQuickSent')?.checked,
          '已完成': !!$('settingsOrderQuickDone')?.checked,
        },
      },
      customers: {
        roles: {
          '上游': !!$('settingsCustomerRoleUpstream')?.checked,
          '下游': !!$('settingsCustomerRoleDownstream')?.checked,
          '兩者': !!$('settingsCustomerRoleBoth')?.checked,
        },
      },
      trips: {
        stopTypes: {
          delivery: !!$('settingsTripTypeDelivery')?.checked,
          pickup: !!$('settingsTripTypePickup')?.checked,
        },
        showManualStopForm: !!$('settingsTripShowManualStopForm')?.checked,
        showOrderPool: !!$('settingsTripShowOrderPool')?.checked,
        showManualRoute: !!$('settingsTripShowManualRoute')?.checked,
      },
    },
  });

  document.querySelectorAll('[data-settings-module-label]').forEach((input) => {
    const moduleId = input.dataset.settingsModuleLabel;
    next.moduleLabels[moduleId] = input.value.trim() || getModuleMeta(moduleId)?.label || moduleId;
  });

  document.querySelectorAll('[data-settings-module-description]').forEach((input) => {
    const moduleId = input.dataset.settingsModuleDescription;
    next.moduleDescriptions[moduleId] = input.value.trim() || getModuleMeta(moduleId)?.description || '';
  });

  document.querySelectorAll('[data-settings-module-page-note]').forEach((input) => {
    const moduleId = input.dataset.settingsModulePageNote;
    next.modulePageNotes[moduleId] = input.value.trim() || `${next.moduleLabels[moduleId] || moduleId} 的頁面說明`;
  });

  document.querySelectorAll('[data-settings-module-icon]').forEach((input) => {
    const moduleId = input.dataset.settingsModuleIcon;
    next.moduleIcons[moduleId] = input.value.trim() || getModuleMeta(moduleId)?.icon || '⚙️';
  });

  document.querySelectorAll('[data-settings-module-enabled]').forEach((input) => {
    next.moduleEnabled[input.dataset.settingsModuleEnabled] = input.checked;
  });

  return next;
}

function landingLabel(viewId) {
  if (viewId === 'dashboardView') return '功能導航';
  return getModuleMeta(viewId)?.label || viewId;
}

function normalizeLandingView(settingsLike) {
  const settings = mergeSettings(settingsLike);
  const landing = settings.defaultLandingView || 'dashboardView';
  if (landing === 'dashboardView') return landing;
  return isModuleEnabledInSettings(settings, landing) ? landing : 'dashboardView';
}

function updateSettingsPreview(settingsLike) {
  const settings = mergeSettings(settingsLike);
  const enabledCount = MODULE_DEFINITIONS.filter((module) => isModuleEnabledInSettings(settings, module.id)).length;
  const landingView = normalizeLandingView(settings);
  if ($('settingsPreviewTitle')) $('settingsPreviewTitle').textContent = settings.appTitle;
  if ($('settingsPreviewCompany')) $('settingsPreviewCompany').textContent = `${settings.companyName}｜${settings.companyIndustry}｜${settings.companyPhone}`;
  if ($('settingsPreviewMessage')) $('settingsPreviewMessage').textContent = settings.dashboardAnnouncement || settings.dashboardHeroSubtitle;
  if ($('settingsPreviewSummary')) $('settingsPreviewSummary').textContent = `已啟用 ${enabledCount} 個模組｜首頁 ${landingLabel(landingView)}｜${settings.openAccess ? '全員可用模式' : '角色權限模式'}`;
}

export function applyUiSettings(state) {
  const settings = ensureSettings(state);
  applyRuntimeBranding(settings);

  if ($('appLoginTitle')) $('appLoginTitle').textContent = settings.loginTitle;
  if ($('appLoginAddress')) $('appLoginAddress').textContent = `${settings.companyAddress}｜${settings.companyIndustry}｜${settings.companyPhone}`;
  if ($('appLoginMessage')) $('appLoginMessage').textContent = settings.loginMessage;
  if ($('dashboardHeroTitle')) $('dashboardHeroTitle').textContent = settings.dashboardHeroTitle;
  if ($('dashboardHeroSubtitle')) $('dashboardHeroSubtitle').textContent = settings.dashboardHeroSubtitle;
  if ($('dashboardAnnouncement')) $('dashboardAnnouncement').textContent = settings.dashboardAnnouncement;
  if ($('welcomeText') && state.user) $('welcomeText').textContent = `${settings.welcomePrefix || '你好'}，${state.user}（${state.userRole || 'viewer'}）`;

  document.querySelectorAll('[data-module-title]').forEach((el) => {
    const moduleId = el.dataset.moduleTitle;
    el.textContent = settings.moduleLabels[moduleId] || getModuleMeta(moduleId)?.label || moduleId;
  });

  document.querySelectorAll('[data-module-note]').forEach((el) => {
    const moduleId = el.dataset.moduleNote;
    el.textContent = settings.modulePageNotes[moduleId] || settings.moduleDescriptions[moduleId] || '';
  });

  document.querySelectorAll('.nav-card').forEach((card) => {
    const moduleId = card.dataset.target;
    const module = getModuleMeta(moduleId);
    const label = settings.moduleLabels[moduleId] || module?.label || moduleId;
    const description = settings.moduleDescriptions[moduleId] || module?.description || '可於設定中自訂此模組';
    const icon = settings.moduleIcons[moduleId] || module?.icon || '⚙️';
    card.innerHTML = `<span class="nav-card-icon">${icon}</span><strong>${label}</strong>`;
    card.title = description;
  });

  updateSettingsPreview(settings);
  return settings;
}

export function renderSettings(state) {
  const settings = ensureSettings(state);
  fillForm(settings);
}

export function bindSettingsEvents(state, saveState, renderAll) {
  const adminHeaders = (json = false) => ({
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${state.authToken || ''}`,
  });

  const adminAction = async (payload) => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const renderNewAccountPermissions = () => {
    const role = $('newAccountRole')?.value || 'viewer';
    renderPermissionChecks($('newAccountModules'), defaultViewsForRole(role));
  };

  const loadAccounts = async () => {
    if (state.userRole !== 'admin' || !$('accountPermissionsList')) return;
    const data = await adminAction({ action: 'list_accounts' });
    $('accountPermissionsList').innerHTML = (data.accounts || []).map(accountPermissionHtml).join('') || '<p class="sub">目前沒有帳號資料。</p>';
  };

  const loadCapacity = async () => {
    if (state.userRole !== 'admin' || !$('capacitySummary')) return;
    $('capacitySummary').textContent = '檢測中...';
    const res = await fetch('/api/admin/capacity', { headers: adminHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderCapacity(data);
  };

  renderNewAccountPermissions();
  loadAccounts().catch((err) => console.warn('account permission list failed', err));
  loadCapacity().catch((err) => {
    if ($('capacitySummary')) $('capacitySummary').textContent = `容量檢測失敗：${err.message}`;
  });

  $('newAccountRole')?.addEventListener('change', renderNewAccountPermissions);
  $('refreshAccountsBtn')?.addEventListener('click', () => {
    loadAccounts().catch((err) => alert(`刷新帳號失敗：${err.message}`));
  });
  $('refreshCapacityBtn')?.addEventListener('click', () => {
    loadCapacity().catch((err) => alert(`容量檢測失敗：${err.message}`));
  });
  $('accountPermissionsList')?.addEventListener('change', (e) => {
    const select = e.target.closest('[data-account-role]');
    if (!select) return;
    const row = select.closest('[data-account-permission-row]');
    const selected = defaultViewsForRole(select.value);
    row?.querySelectorAll('[data-account-module]').forEach((input) => {
      input.checked = selected.includes(input.value);
    });
  });
  $('accountPermissionsList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-save-account-permissions]');
    if (!btn) return;
    const row = btn.closest('[data-account-permission-row]');
    if (!row) return;
    try {
      const role = row.querySelector('[data-account-role]')?.value || 'viewer';
      const allowedViews = [...row.querySelectorAll('[data-account-module]:checked')].map((input) => input.value);
      await adminAction({ action: 'update_account_permissions', id: row.dataset.accountPermissionRow, role, allowedViews });
      alert('帳號權限已更新。下次登入會套用新權限。');
      await loadAccounts();
    } catch (err) {
      alert(`更新帳號權限失敗：${err.message}`);
    }
  });

  const downloadJson = (filename, value) => {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const clearTestData = async () => {
    const confirmText = '清空測試資料';
    const input = window.prompt(`這會清掉工單、客戶、收付款、庫存、稽核、通知和 AI 修正紀錄。\n帳號、財務密碼與系統設定會保留。\n\n如果確定要清空，請輸入：${confirmText}`);
    if (input !== confirmText) return;
    const res = await fetch('/api/admin/clear-test-data', {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ confirm: confirmText }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const readBackupFile = async (file) => {
    if (!file) throw new Error('請先選擇備份檔。');
    const text = await file.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('備份檔不是有效 JSON。');
    }
  };

  $('createAccountForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const password = $('newAccountPassword')?.value || '';
    const confirm = $('newAccountPasswordConfirm')?.value || '';
    if (password !== confirm) return alert('兩次輸入的帳戶密碼不同。');
    try {
      await adminAction({
        action: 'create_account',
        username: $('newAccountUsername')?.value.trim(),
        display: $('newAccountDisplay')?.value.trim(),
        role: $('newAccountRole')?.value,
        allowedViews: selectedPermissionViews($('newAccountModules')),
        password,
      });
      form?.reset();
      renderNewAccountPermissions();
      await loadAccounts();
      alert('帳戶已新增。');
    } catch (err) {
      alert(`新增帳戶失敗：${err.message}`);
    }
  });

  $('financePasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const password = $('newFinancePassword')?.value || '';
    const confirm = $('newFinancePasswordConfirm')?.value || '';
    if (password !== confirm) return alert('兩次輸入的財經密碼不同。');
    try {
      await adminAction({ action: 'change_finance_password', password });
      form?.reset();
      alert('財經密碼已更新。');
    } catch (err) {
      alert(`更改財經密碼失敗：${err.message}`);
    }
  });

  $('clearTestDataBtn')?.addEventListener('click', async () => {
    try {
      const result = await clearTestData();
      const total = Object.values(result.cleared || {}).reduce((sum, count) => sum + Number(count || 0), 0);
      alert(`測試資料已清空，共清除 ${total} 筆。系統會重新整理畫面。`);
      window.location.reload();
    } catch (err) {
      alert(`清空測試資料失敗：${err.message}`);
    }
  });

  $('downloadBackupBtn')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/backup', { headers: adminHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      downloadJson(`sanqing-backup-${stamp}.json`, data.backup);
      alert('備份檔已下載。請把它放在安全的位置。');
    } catch (err) {
      alert(`下載備份失敗：${err.message}`);
    }
  });

  $('restoreBackupBtn')?.addEventListener('click', async () => {
    try {
      const backup = await readBackupFile($('restoreBackupFile')?.files?.[0]);
      const confirmText = '還原備份';
      const input = window.prompt(`還原會覆蓋目前工單、客戶、財經、庫存、稽核、通知與 AI 修正紀錄。\n帳號與財務密碼會保留。\n\n如果確定要還原，請輸入：${confirmText}`);
      if (input !== confirmText) return;
      const res = await fetch('/api/admin/restore', {
        method: 'POST',
        headers: adminHeaders(true),
        body: JSON.stringify({ confirm: confirmText, backup }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      alert('備份已還原，系統會重新整理畫面。');
      window.location.reload();
    } catch (err) {
      alert(`還原備份失敗：${err.message}`);
    }
  });

  $('settingsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings = collectSettings();
    state.settings.defaultLandingView = normalizeLandingView(state.settings);
      saveState();
    renderAll();
    alert('設定已儲存，畫面、模組與警示門檻已立即更新。');
  });

  $('resetSettingsBtn')?.addEventListener('click', () => {
    state.settings = getDefaultSettings();
      saveState();
    renderAll();
    alert('已恢復預設設定。');
  });

  $('settingsForm')?.addEventListener('input', () => {
    const preview = collectSettings();
    applyRuntimeBranding(preview);
    updateSettingsPreview(preview);
  });

  $('settingsForm')?.addEventListener('change', () => {
    const preview = collectSettings();
    updateSettingsPreview(preview);
    if ($('settingsModulesList')) $('settingsModulesList').innerHTML = moduleSettingsHtml(preview);
  });
}
