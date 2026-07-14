export const COMPANY_INFO = {
  name: '三青實業有限公司',
  address: 'No. 53, Liyan St, Zhonghe District, New Taipei City, Taiwan 235',
};

export const MODULE_DEFINITIONS = [
  { id: 'ordersView', label: '工單作業系統', icon: '工', description: '新增、查詢與匯出工單資料' },
  { id: 'customersView', label: '客戶資料系統', icon: '客', description: '集中維護客戶、角色與地址' },
  { id: 'tripsView', label: '車趟系統', icon: '車', description: '安排送貨、載貨與路線最佳化' },
  { id: 'opsCenterView', label: '營運中心', icon: '營', description: '掌握待辦、進度與異常工單' },
  { id: 'inventoryView', label: '庫存中心', icon: '庫', description: '管理原料、耗材與安全庫存' },
  { id: 'notificationsView', label: '通知中心', icon: '通', description: '查看提醒、事件與系統動態' },
  { id: 'financeView', label: '財經資料系統', icon: '財', description: '應收、應付、發票與報表分析' },
  { id: 'auditView', label: '稽核系統', icon: '稽', description: '追蹤工單異動與稽核紀錄' },
];

const moduleMap = (key) => Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, module[key]]));
const DEFAULT_SETTINGS = {
  appTitle: '上光廠智慧營運平台', loginTitle: '三青實業有限公司智慧營運平台', companyName: COMPANY_INFO.name,
  companyAddress: COMPANY_INFO.address, companyPhone: '02-2222-2222', companyIndustry: '印刷 / 製造業',
  companyEmail: 'service@example.com', companyWebsite: 'https://example.com', companyTaxId: '12345678',
  loginMessage: '請先登入系統，進入各模組進行管理與協作。', dashboardHeroTitle: '讓每個角色都能快速上手的營運控制台',
  dashboardHeroSubtitle: '可在設定中調整品牌、模組名稱、權限開放與主題色。', dashboardAnnouncement: '建議每日檢視待辦與異常提醒。',
  welcomePrefix: '你好', defaultLandingView: 'dashboardView', themePrimary: '#f59e0b', themeAccent: '#8b5cf6', themePanel: '#1f2937',
  openAccess: true, enableKeyboardShortcut: true, orderWarningDays: 3, receivableOverdueDays: 30, payableWarningDays: 14, inventoryLowStockDefault: 100,
  moduleInternals: {
    orders: {
      statuses: { 未完成: true, 已送出: true, 已完成: true },
      quickActions: { 已送出: true, 已完成: true },
      showFilters: true,
      showExport: true,
      showAiTools: true,
      pricingRules: {
        divisor: 4680,
        sizePresets: '',
        dimensionThresholds: {
          small: { shortMax: 18, longMax: 26 },
          regular: { shortMax: 25, longMax: 35 },
        },
        tierPrices: {
          BIG: { PVA: 900, PVB: 700, WEAR: 900, PRESS: 850 },
          REGULAR: { PVA: 850, PVB: 650, WEAR: 850, PRESS: 800 },
          SMALL: { PVA: 1, PVB: 1, WEAR: 1, PRESS: 1 },
        },
        minimumCharges: { BIG: 1000, REGULAR: 800, SMALL: 600 },
      },
    },
    customers: { roles: { 上游: true, 下游: true, 兩者: true } },
    trips: { stopTypes: { delivery: true, pickup: true }, showManualRoute: true, showManualStopForm: true, showOrderPool: true },
  },
  modulePageNotes: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, `${module.label}的首頁說明，可依公司需求調整。`])),
  moduleLabels: moduleMap('label'), moduleDescriptions: moduleMap('description'), moduleIcons: moduleMap('icon'),
  moduleEnabled: Object.fromEntries(MODULE_DEFINITIONS.map((module) => [module.id, true])),
};

export const $ = (id) => document.getElementById(id);
export const money = (n) => Number(n || 0).toLocaleString();
export const getTodayText = () => new Date().toISOString().slice(0, 10);
export const getDefaultSettings = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
export const formatTs = (ts) => ts ? new Date(ts).toLocaleTimeString() : '已儲存';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function sanitizePlainText(value, maxLength = 200) {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, maxLength);
}

function sanitizeMap(values, defaults, maxLength) {
  return Object.fromEntries(Object.keys(defaults).map((key) => [key, sanitizePlainText(values?.[key] ?? defaults[key], maxLength) || defaults[key]]));
}

export function mergeSettings(raw = {}) {
  const defaults = getDefaultSettings();
  const textFields = ['appTitle', 'loginTitle', 'companyName', 'companyAddress', 'companyPhone', 'companyIndustry', 'companyEmail', 'companyWebsite', 'companyTaxId', 'loginMessage', 'dashboardHeroTitle', 'dashboardHeroSubtitle', 'dashboardAnnouncement', 'welcomePrefix'];
  const merged = { ...defaults, ...raw };
  textFields.forEach((field) => { merged[field] = sanitizePlainText(merged[field], field.includes('Subtitle') || field.includes('Message') ? 500 : 200) || defaults[field]; });
  merged.moduleLabels = sanitizeMap(raw.moduleLabels, defaults.moduleLabels, 80);
  merged.moduleDescriptions = sanitizeMap(raw.moduleDescriptions, defaults.moduleDescriptions, 300);
  merged.moduleIcons = sanitizeMap(raw.moduleIcons, defaults.moduleIcons, 8);
  merged.modulePageNotes = sanitizeMap(raw.modulePageNotes, defaults.modulePageNotes, 300);
  merged.moduleEnabled = { ...defaults.moduleEnabled, ...(raw.moduleEnabled || {}) };
  merged.moduleInternals = {
    orders: {
      ...defaults.moduleInternals.orders,
      ...(raw.moduleInternals?.orders || {}),
      statuses: { ...defaults.moduleInternals.orders.statuses, ...(raw.moduleInternals?.orders?.statuses || {}) },
      quickActions: { ...defaults.moduleInternals.orders.quickActions, ...(raw.moduleInternals?.orders?.quickActions || {}) },
      pricingRules: {
        ...defaults.moduleInternals.orders.pricingRules,
        ...(raw.moduleInternals?.orders?.pricingRules || {}),
        dimensionThresholds: {
          small: {
            ...defaults.moduleInternals.orders.pricingRules.dimensionThresholds.small,
            ...(raw.moduleInternals?.orders?.pricingRules?.dimensionThresholds?.small || {}),
          },
          regular: {
            ...defaults.moduleInternals.orders.pricingRules.dimensionThresholds.regular,
            ...(raw.moduleInternals?.orders?.pricingRules?.dimensionThresholds?.regular || {}),
          },
        },
        tierPrices: {
          BIG: {
            ...defaults.moduleInternals.orders.pricingRules.tierPrices.BIG,
            ...(raw.moduleInternals?.orders?.pricingRules?.basePrices || {}),
            ...(raw.moduleInternals?.orders?.pricingRules?.tierPrices?.BIG || {}),
          },
          REGULAR: {
            ...defaults.moduleInternals.orders.pricingRules.tierPrices.REGULAR,
            ...(raw.moduleInternals?.orders?.pricingRules?.tierPrices?.REGULAR || {}),
          },
          SMALL: {
            ...defaults.moduleInternals.orders.pricingRules.tierPrices.SMALL,
            ...(raw.moduleInternals?.orders?.pricingRules?.tierPrices?.SMALL || {}),
          },
        },
        minimumCharges: { ...defaults.moduleInternals.orders.pricingRules.minimumCharges, ...(raw.moduleInternals?.orders?.pricingRules?.minimumCharges || {}) },
      },
    },
    customers: { ...defaults.moduleInternals.customers, ...(raw.moduleInternals?.customers || {}), roles: { ...defaults.moduleInternals.customers.roles, ...(raw.moduleInternals?.customers?.roles || {}) } },
    trips: { ...defaults.moduleInternals.trips, ...(raw.moduleInternals?.trips || {}), stopTypes: { ...defaults.moduleInternals.trips.stopTypes, ...(raw.moduleInternals?.trips?.stopTypes || {}) } },
  };
  return merged;
}

export function toCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
}

export function downloadCsv(filename, rows) {
  const blob = new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

function normalizeHex(color, fallback) { const text = String(color || '').trim(); return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback; }
function shadeHex(hex, amount = -24) {
  const pairs = normalizeHex(hex, '#f59e0b').slice(1).match(/.{2}/g) || ['f5', '9e', '0b'];
  return `#${pairs.map((pair) => Math.max(0, Math.min(255, parseInt(pair, 16) + amount)).toString(16).padStart(2, '0')).join('')}`;
}

export function applyRuntimeBranding(settingsLike = {}) {
  const settings = mergeSettings(settingsLike); COMPANY_INFO.name = settings.companyName; COMPANY_INFO.address = settings.companyAddress; document.title = settings.appTitle;
  const root = document.documentElement; root.style.setProperty('--primary', normalizeHex(settings.themePrimary, '#f59e0b')); root.style.setProperty('--primary-dark', shadeHex(settings.themePrimary, -34)); root.style.setProperty('--accent', normalizeHex(settings.themeAccent, '#8b5cf6')); root.style.setProperty('--card', normalizeHex(settings.themePanel, '#1f2937')); root.style.setProperty('--card-soft', shadeHex(settings.themePanel, 10)); root.style.setProperty('--card-strong', shadeHex(settings.themePanel, -12));
  document.body.dataset.openAccess = settings.openAccess ? 'true' : 'false'; return settings;
}

export function isModuleSettingEnabled(value) {
  if (value === false || value === 0 || value === 'false') return false;
  if (!value || typeof value !== 'object') return true;
  return ['enabled', 'isEnabled', 'visible', 'active'].every((key) => ![false, 0, 'false'].includes(value[key]));
}
export const isModuleEnabledInSettings = (settingsLike = {}, viewId) => isModuleSettingEnabled(settingsLike?.moduleEnabled?.[viewId]);
export const getModuleMeta = (viewId) => MODULE_DEFINITIONS.find((module) => module.id === viewId) || null;
