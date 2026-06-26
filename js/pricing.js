export const PRICING_TIERS = ['BIG', 'REGULAR', 'SMALL'];
export const REAM_TIERS = ['BIG', 'REGULAR'];
export const COATING_TYPES = ['PVA', 'PVB', 'WEAR', 'PRESS'];

export const DEFAULT_PRICING_RULES = {
  divisor: 4680,
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
};

export function toTaiInch(value, unit = 'mm') {
  const num = Number(value || 0);
  if (!num) return 0;
  const mm = unit === 'cm' ? num * 10 : unit === 'inch' ? num * 25.4 : unit === 'tai-inch' ? num * 30.3 : num;
  return mm / 30.3;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeTierPrices(source = {}, legacyBasePrices = {}) {
  return Object.fromEntries(PRICING_TIERS.map((tier) => [
    tier,
    Object.fromEntries(COATING_TYPES.map((type) => [
      type,
      positive(source?.[tier]?.[type], positive(legacyBasePrices?.[type], DEFAULT_PRICING_RULES.tierPrices[tier][type])),
    ])),
  ]));
}

export function normalizePricingRules(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const dimensionThresholds = {
    small: {
      shortMax: positive(source.dimensionThresholds?.small?.shortMax, DEFAULT_PRICING_RULES.dimensionThresholds.small.shortMax),
      longMax: positive(source.dimensionThresholds?.small?.longMax, DEFAULT_PRICING_RULES.dimensionThresholds.small.longMax),
    },
    regular: {
      shortMax: positive(source.dimensionThresholds?.regular?.shortMax, DEFAULT_PRICING_RULES.dimensionThresholds.regular.shortMax),
      longMax: positive(source.dimensionThresholds?.regular?.longMax, DEFAULT_PRICING_RULES.dimensionThresholds.regular.longMax),
    },
  };
  if (dimensionThresholds.regular.shortMax < dimensionThresholds.small.shortMax) dimensionThresholds.regular.shortMax = dimensionThresholds.small.shortMax;
  if (dimensionThresholds.regular.longMax < dimensionThresholds.small.longMax) dimensionThresholds.regular.longMax = dimensionThresholds.small.longMax;
  return {
    divisor: positive(source.divisor, DEFAULT_PRICING_RULES.divisor),
    dimensionThresholds,
    tierPrices: normalizeTierPrices(source.tierPrices, source.basePrices),
    minimumCharges: Object.fromEntries(PRICING_TIERS.map((tier) => [
      tier,
      positive(source.minimumCharges?.[tier], DEFAULT_PRICING_RULES.minimumCharges[tier]),
    ])),
  };
}

export function coatingTypeCode(value = '') {
  const text = String(value).trim().toUpperCase();
  if (text.includes('PVA') || text.includes('A光')) return 'PVA';
  if (text.includes('PVB') || text.includes('B光')) return 'PVB';
  if (text.includes('耐磨') || text === 'WEAR') return 'WEAR';
  if (text.includes('壓光') || text === 'PRESS') return 'PRESS';
  return '';
}

export function normalizePricingTier(value = '') {
  const tier = String(value || '').trim().toUpperCase();
  if (tier === 'SMALL') return 'SMALL';
  if (tier === 'REGULAR') return 'REGULAR';
  return 'BIG';
}

export function classifyPricingTier(widthTai, heightTai, rules = {}) {
  const settings = normalizePricingRules(rules);
  const width = Number(widthTai || 0);
  const height = Number(heightTai || 0);
  if (!width || !height) return 'BIG';
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide <= settings.dimensionThresholds.small.shortMax && longSide <= settings.dimensionThresholds.small.longMax) return 'SMALL';
  if (shortSide <= settings.dimensionThresholds.regular.shortMax && longSide <= settings.dimensionThresholds.regular.longMax) return 'REGULAR';
  return 'BIG';
}

function defaultTierBounds(rules = {}) {
  const settings = normalizePricingRules(rules);
  return {
    SMALL: {
      shortMin: 0,
      shortMax: settings.dimensionThresholds.small.shortMax,
      longMin: 0,
      longMax: settings.dimensionThresholds.small.longMax,
    },
    REGULAR: {
      shortMin: settings.dimensionThresholds.small.shortMax,
      shortMax: settings.dimensionThresholds.regular.shortMax,
      longMin: settings.dimensionThresholds.small.longMax,
      longMax: settings.dimensionThresholds.regular.longMax,
    },
  };
}

export function normalizeCustomerTierBounds(value = {}, rules = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = defaultTierBounds(rules);
  return Object.fromEntries(['SMALL', 'REGULAR'].map((tier) => {
    const row = source[tier] || source[tier.toLowerCase()] || {};
    const fallback = defaults[tier];
    const shortMin = nonNegative(row.shortMin, fallback.shortMin);
    const shortMax = Math.max(shortMin, nonNegative(row.shortMax, fallback.shortMax));
    const longMin = nonNegative(row.longMin, fallback.longMin);
    const longMax = Math.max(longMin, nonNegative(row.longMax, fallback.longMax));
    return [tier, { shortMin, shortMax, longMin, longMax }];
  }));
}

export function findCustomerTierBounds(state, customerName = '') {
  const customer = String(customerName || '').trim().toLowerCase();
  if (!customer) return null;
  const rule = (state.priceRules || []).find((item) => (
    item?.priceScope === 'customer-tier-bounds'
    && String(item.customer || '').trim().toLowerCase() === customer
  ));
  return rule?.tierBounds || null;
}

export function classifyPricingTierWithBounds(widthTai, heightTai, bounds = null, rules = {}) {
  if (!bounds) return classifyPricingTier(widthTai, heightTai, rules);
  const width = Number(widthTai || 0);
  const height = Number(heightTai || 0);
  if (!width || !height) return 'BIG';
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const normalized = normalizeCustomerTierBounds(bounds, rules);
  const inside = (tier) => (
    shortSide >= normalized[tier].shortMin
    && shortSide <= normalized[tier].shortMax
    && longSide >= normalized[tier].longMin
    && longSide <= normalized[tier].longMax
  );
  if (inside('SMALL')) return 'SMALL';
  if (inside('REGULAR')) return 'REGULAR';
  return 'BIG';
}

export function classifyOrderPricingTier(state, order = {}) {
  const width = toTaiInch(order.sizeWidth, order.sizeUnit);
  const height = toTaiInch(order.sizeLength, order.sizeUnit);
  const settings = state.settings?.moduleInternals?.orders?.pricingRules;
  return classifyPricingTierWithBounds(width, height, findCustomerTierBounds(state, order.billingCustomer), settings);
}

function closeSize(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.15;
}

export function findCustomerPriceRule(state, order = {}) {
  const customer = String(order.billingCustomer || '').trim().toLowerCase();
  if (!customer) return null;
  const glossType = String(order.glossType || '').trim();
  const lengthTai = toTaiInch(order.sizeLength, order.sizeUnit);
  const widthTai = toTaiInch(order.sizeWidth, order.sizeUnit);
  if (!lengthTai || !widthTai) return null;
  const tier = normalizePricingTier(order.machineType || classifyOrderPricingTier(state, order));

  const matches = (state.priceRules || []).filter((rule) => {
    if (rule?.priceScope === 'customer-tier-bounds') return false;
    if (String(rule.customer || '').trim().toLowerCase() !== customer) return false;
    if (rule.glossType && glossType && coatingTypeCode(rule.glossType) !== coatingTypeCode(glossType)) return false;
    if (rule.machineType && rule.machineType !== 'ANY' && normalizePricingTier(rule.machineType) !== tier) return false;
    const ruleLength = rule.sizeLengthTai || toTaiInch(rule.sizeLength, rule.sizeUnit);
    const ruleWidth = rule.sizeWidthTai || toTaiInch(rule.sizeWidth, rule.sizeUnit);
    if (!ruleLength && !ruleWidth) return true;
    return (closeSize(ruleLength, lengthTai) && closeSize(ruleWidth, widthTai))
      || (closeSize(ruleLength, widthTai) && closeSize(ruleWidth, lengthTai));
  });
  return matches.find((rule) => Number(rule.sizeLengthTai || rule.sizeLength || 0) && Number(rule.sizeWidthTai || rule.sizeWidth || 0))
    || matches[0]
    || null;
}

export function calculateOrderQuote(state, order = {}) {
  const width = toTaiInch(order.sizeWidth, order.sizeUnit);
  const height = toTaiInch(order.sizeLength, order.sizeUnit);
  const quantity = Number(order.sheetCount || 0);
  const coatingType = coatingTypeCode(order.glossType);
  if (!width || !height || !quantity || !coatingType) return null;

  const settings = normalizePricingRules(state.settings?.moduleInternals?.orders?.pricingRules);
  const tier = normalizePricingTier(order.machineType || classifyOrderPricingTier(state, order));
  const customerRule = findCustomerPriceRule(state, { ...order, machineType: tier });
  if (customerRule && customerRule.pricingMode !== 'formula') {
    const finalPrice = Math.round(quantity * Number(customerRule.unitPrice || 0));
    return { unitPrice: Number(customerRule.unitPrice || 0), calculatedPrice: finalPrice, finalPrice, minimumApplied: false, source: 'legacy-customer', customerRule, pricingTier: tier, pricingMode: 'sheet' };
  }

  const unitPrice = positive(customerRule?.unitPrice, settings.tierPrices[tier]?.[coatingType] || settings.tierPrices.BIG[coatingType]);
  const pricingMode = tier === 'SMALL' ? 'sheet' : 'ream';
  const calculatedPrice = pricingMode === 'sheet'
    ? Math.round(quantity * unitPrice)
    : Math.round((width * height * quantity * unitPrice) / (settings.divisor * 100));
  const minimum = settings.minimumCharges[tier] || 0;
  return {
    unitPrice: Math.round(unitPrice * 100) / 100,
    calculatedPrice,
    finalPrice: Math.max(calculatedPrice, Math.round(minimum)),
    minimumApplied: calculatedPrice < minimum,
    source: customerRule ? 'customer-formula' : 'default-formula',
    customerRule,
    pricingTier: tier,
    pricingMode,
  };
}

export function estimateOrderPriceFromRule(rule, sheetCount) {
  const count = Number(sheetCount || 0);
  const unitPrice = Number(rule?.unitPrice || 0);
  if (!rule || !count || !unitPrice) return 0;
  return Math.round(count * unitPrice);
}
