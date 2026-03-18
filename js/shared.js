export const COMPANY_INFO = {
  name: '三青實業有限公司',
  address: 'No. 53, Liyan St, Zhonghe District, New Taipei City, Taiwan 235',
};

export const MODULE_DEFINITIONS = [
  { id: 'ordersView', label: '工單作業系統', icon: '🧾', description: '新增、查詢與匯出工單資料' },
  { id: 'customersView', label: '客戶資料系統', icon: '👥', description: '集中維護客戶、角色與地址' },
  { id: 'tripsView', label: '車趟系統', icon: '🚚', description: '安排送貨／載貨與路線最佳化' },
  { id: 'opsCenterView', label: '營運中心', icon: '🏭', description: '掌握待辦、進度與異常工單' },
  { id: 'inventoryView', label: '庫存中心', icon: '📦', description: '管理原料、耗材與安全庫存' },
  { id: 'notificationsView', label: '通知中心', icon: '🔔', description: '查看提醒、事件與系統動態' },
  { id: 'financeView', label: '財經資料系統', icon: '💰', description: '應收、應付、發票與報表分析' },
  { id: 'auditView', label: '稽核系統', icon: '🛡️', description: '追蹤工單異動與稽核紀錄' },
];

const DEFAULT_SETTINGS = {
  appTitle: '上光廠智慧營運平台',
  loginTitle: '三青實業有限公司智慧營運平台',
  companyName: '三青實業有限公司',
  companyAddress: 'No. 53, Liyan St, Zhonghe District, New Taipei City, Taiwan 235',
  companyPhone: '02-2222-2222',
  companyEmail: 'service@example.com',
  companyWebsite: 'https://example.com',
  companyTaxId: '12345678',
  loginMessage: '請先登入系統，進入各模組進行管理與協作。',
  dashboardHeroTitle: '讓每個角色都能快速上手的營運控制台',
  dashboardHeroSubtitle: '你可以在設定中調整品牌、模組名稱、權限開放與主題色，讓整個網站更適合團隊共同使用。',
  dashboardAnnouncement: '建議每日由營運中心追蹤待辦、由通知中心檢視異常提醒。',
  welcomePrefix: '你好',
  defaultLandingView: 'dashboardView',
  themePrimary: '#f59e0b',
  themeAccent: '#8b5cf6',
  themePanel: '#1f2937',
  openAccess: true,
  financeGateEnabled: false,
  financePassword: '123',
  enableKeyboardShortcut: true,
  orderWarningDays: 3,
  receivableOverdueDays: 30,
  payableWarningDays: 14,
  inventoryLowStockDefault: 100,
  moduleLabels: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, module.label])),
  moduleDescriptions: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, module.description])),
  moduleIcons: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, module.icon])),
  moduleEnabled: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, true])),
};

export const $ = (id) => document.getElementById(id);

export function money(n) {
  return Number(n || 0).toLocaleString();
}

export function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
}

export function downloadCsv(filename, rows) {
  const blob = new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function formatTs(ts) {
  if (!ts) return '尚未同步';
  return new Date(ts).toLocaleTimeString();
}

export function getTodayText() {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function mergeSettings(raw = {}) {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    ...raw,
    moduleLabels: { ...defaults.moduleLabels, ...(raw.moduleLabels || {}) },
    moduleDescriptions: { ...defaults.moduleDescriptions, ...(raw.moduleDescriptions || {}) },
    moduleIcons: { ...defaults.moduleIcons, ...(raw.moduleIcons || {}) },
    moduleEnabled: { ...defaults.moduleEnabled, ...(raw.moduleEnabled || {}) },
  };
}

function normalizeHex(color, fallback) {
  const text = String(color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function shadeHex(hex, amount = -24) {
  const base = normalizeHex(hex, '#f59e0b').slice(1);
  const pairs = base.match(/.{2}/g) || ['f5', '9e', '0b'];
  const adjusted = pairs.map((pair) => {
    const next = Math.max(0, Math.min(255, parseInt(pair, 16) + amount));
    return next.toString(16).padStart(2, '0');
  }).join('');
  return `#${adjusted}`;
}

export function applyRuntimeBranding(settingsLike = {}) {
  const settings = mergeSettings(settingsLike);
  COMPANY_INFO.name = settings.companyName;
  COMPANY_INFO.address = settings.companyAddress;

  document.title = settings.appTitle;
  const root = document.documentElement;
  root.style.setProperty('--primary', normalizeHex(settings.themePrimary, '#f59e0b'));
  root.style.setProperty('--primary-dark', shadeHex(settings.themePrimary, -34));
  root.style.setProperty('--accent', normalizeHex(settings.themeAccent, '#8b5cf6'));
  root.style.setProperty('--card', normalizeHex(settings.themePanel, '#1f2937'));
  root.style.setProperty('--card-soft', shadeHex(settings.themePanel, 10));
  root.style.setProperty('--card-strong', shadeHex(settings.themePanel, -12));
  document.body.dataset.openAccess = settings.openAccess ? 'true' : 'false';
  return settings;
}

export function getModuleMeta(viewId) {
  return MODULE_DEFINITIONS.find((module) => module.id === viewId) || null;
}
