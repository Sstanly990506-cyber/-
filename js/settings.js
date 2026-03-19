import { $, MODULE_DEFINITIONS, applyRuntimeBranding, getDefaultSettings, getModuleMeta, mergeSettings } from './shared.js';

function ensureSettings(state) {
  state.settings = mergeSettings(state.settings || {});
  state.financePassword = state.settings.financePassword;
  return state.settings;
}

function moduleSettingsHtml(settings) {
  return MODULE_DEFINITIONS.map((module) => {
    const label = settings.moduleLabels[module.id] || module.label;
    const description = settings.moduleDescriptions[module.id] || module.description;
    const icon = settings.moduleIcons[module.id] || module.icon;
    const pageNote = settings.modulePageNotes[module.id] || `${label} 的頁面說明`;
    const enabled = settings.moduleEnabled[module.id] !== false;
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
    settingsFinancePassword: settings.financePassword,
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
  if ($('settingsFinanceGateEnabled')) $('settingsFinanceGateEnabled').checked = !!settings.financeGateEnabled;
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
    financeGateEnabled: !!$('settingsFinanceGateEnabled')?.checked,
    financePassword: $('settingsFinancePassword')?.value.trim() || defaults.financePassword,
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
  return settings.moduleEnabled?.[landing] === false ? 'dashboardView' : landing;
}

function updateSettingsPreview(settingsLike) {
  const settings = mergeSettings(settingsLike);
  const enabledCount = MODULE_DEFINITIONS.filter((module) => settings.moduleEnabled[module.id] !== false).length;
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
    card.innerHTML = `<span class="nav-card-icon">${icon}</span><strong>${label}</strong><small>${description}</small>`;
  });

  updateSettingsPreview(settings);
  return settings;
}

export function renderSettings(state) {
  const settings = ensureSettings(state);
  fillForm(settings);
}

export function bindSettingsEvents(state, saveState, renderAll) {
  $('settingsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings = collectSettings();
    state.settings.defaultLandingView = normalizeLandingView(state.settings);
    state.financePassword = state.settings.financePassword;
    saveState();
    renderAll();
    alert('設定已儲存，畫面、模組與警示門檻已立即更新。');
  });

  $('resetSettingsBtn')?.addEventListener('click', () => {
    state.settings = getDefaultSettings();
    state.financePassword = state.settings.financePassword;
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
