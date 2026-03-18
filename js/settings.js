import { $, MODULE_DEFINITIONS, applyRuntimeBranding, getDefaultSettings, getModuleMeta, mergeSettings } from './shared.js';

function ensureSettings(state) {
  state.settings = mergeSettings(state.settings || {});
  state.financePassword = state.settings.financePassword;
  return state.settings;
}

function moduleSettingsHtml(settings) {
  return MODULE_DEFINITIONS.map((module) => {
    const label = settings.moduleLabels[module.id] || module.label;
    const enabled = settings.moduleEnabled[module.id] !== false;
    return `
      <label class="settings-module-card">
        <div class="settings-module-head">
          <div>
            <strong>${module.icon} ${module.label}</strong>
            <p class="sub">${module.description}</p>
          </div>
          <span class="toggle-pill ${enabled ? 'on' : 'off'}">${enabled ? '啟用中' : '已停用'}</span>
        </div>
        <input data-settings-module-label="${module.id}" value="${label}" placeholder="模組名稱" />
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
    settingsLoginMessage: settings.loginMessage,
    settingsDashboardHeroTitle: settings.dashboardHeroTitle,
    settingsDashboardHeroSubtitle: settings.dashboardHeroSubtitle,
    settingsThemePrimary: settings.themePrimary,
    settingsThemeAccent: settings.themeAccent,
    settingsThemePanel: settings.themePanel,
    settingsFinancePassword: settings.financePassword,
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = $(id);
    if (el) el.value = value;
  });
  if ($('settingsOpenAccess')) $('settingsOpenAccess').checked = !!settings.openAccess;
  if ($('settingsFinanceGateEnabled')) $('settingsFinanceGateEnabled').checked = !!settings.financeGateEnabled;
  if ($('settingsModulesList')) $('settingsModulesList').innerHTML = moduleSettingsHtml(settings);
  updateSettingsPreview(settings);
}

function collectSettings() {
  const defaults = getDefaultSettings();
  const next = mergeSettings({
    appTitle: $('settingsAppTitle')?.value.trim() || defaults.appTitle,
    loginTitle: $('settingsLoginTitle')?.value.trim() || defaults.loginTitle,
    companyName: $('settingsCompanyName')?.value.trim() || defaults.companyName,
    companyAddress: $('settingsCompanyAddress')?.value.trim() || defaults.companyAddress,
    loginMessage: $('settingsLoginMessage')?.value.trim() || defaults.loginMessage,
    dashboardHeroTitle: $('settingsDashboardHeroTitle')?.value.trim() || defaults.dashboardHeroTitle,
    dashboardHeroSubtitle: $('settingsDashboardHeroSubtitle')?.value.trim() || defaults.dashboardHeroSubtitle,
    themePrimary: $('settingsThemePrimary')?.value || defaults.themePrimary,
    themeAccent: $('settingsThemeAccent')?.value || defaults.themeAccent,
    themePanel: $('settingsThemePanel')?.value || defaults.themePanel,
    openAccess: !!$('settingsOpenAccess')?.checked,
    financeGateEnabled: !!$('settingsFinanceGateEnabled')?.checked,
    financePassword: $('settingsFinancePassword')?.value.trim() || defaults.financePassword,
  });

  document.querySelectorAll('[data-settings-module-label]').forEach((input) => {
    const moduleId = input.dataset.settingsModuleLabel;
    next.moduleLabels[moduleId] = input.value.trim() || getModuleMeta(moduleId)?.label || moduleId;
  });

  document.querySelectorAll('[data-settings-module-enabled]').forEach((input) => {
    next.moduleEnabled[input.dataset.settingsModuleEnabled] = input.checked;
  });

  return next;
}

function updateSettingsPreview(settingsLike) {
  const settings = mergeSettings(settingsLike);
  const enabledCount = MODULE_DEFINITIONS.filter((module) => settings.moduleEnabled[module.id] !== false).length;
  if ($('settingsPreviewTitle')) $('settingsPreviewTitle').textContent = settings.appTitle;
  if ($('settingsPreviewCompany')) $('settingsPreviewCompany').textContent = `${settings.companyName}｜${settings.companyAddress}`;
  if ($('settingsPreviewMessage')) $('settingsPreviewMessage').textContent = settings.dashboardHeroSubtitle;
  if ($('settingsPreviewSummary')) $('settingsPreviewSummary').textContent = `已啟用 ${enabledCount} 個模組｜${settings.openAccess ? '全員可用模式' : '角色權限模式'}`;
}

export function applyUiSettings(state) {
  const settings = ensureSettings(state);
  applyRuntimeBranding(settings);

  if ($('appLoginTitle')) $('appLoginTitle').textContent = settings.loginTitle;
  if ($('appLoginAddress')) $('appLoginAddress').textContent = settings.companyAddress;
  if ($('appLoginMessage')) $('appLoginMessage').textContent = settings.loginMessage;
  if ($('dashboardHeroTitle')) $('dashboardHeroTitle').textContent = settings.dashboardHeroTitle;
  if ($('dashboardHeroSubtitle')) $('dashboardHeroSubtitle').textContent = settings.dashboardHeroSubtitle;

  document.querySelectorAll('.nav-card').forEach((card) => {
    const moduleId = card.dataset.target;
    const module = getModuleMeta(moduleId);
    const label = settings.moduleLabels[moduleId] || module?.label || moduleId;
    const description = module?.description || '可於設定中自訂此模組';
    const icon = module?.icon || '⚙️';
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
    state.financePassword = state.settings.financePassword;
    saveState();
    renderAll();
    alert('設定已儲存，畫面與權限已立即更新。');
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
