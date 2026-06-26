export const PRICING_TIERS = ['BIG', 'REGULAR', 'SMALL'];
export const REAM_TIERS = ['BIG', 'REGULAR'];
export const COATING_TYPES = ['PVA', 'PVB', 'WEAR', 'PRESS'];

export const DEFAULT_PRICING_RULES = {
  divisor: 4680,
  areaThresholds: { smallMax: 340, regularMax: 620 },
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
  const legacySmall = positive(source.smallAreaThreshold, DEFAULT_PRICING_RULES.areaThresholds.smallMax);
  const areaThresholds = {
    smallMax: positive(source.areaThresholds?.smallMax, legacySmall),
    regularMax: positive(source.areaThresholds?.regularMax, DEFAULT_PRICING_RULES.areaThresholds.regularMax),
  };
  if (areaThresholds.regularMax < areaThresholds.smallMax) areaThresholds.regularMax = areaThresholds.smallMax;
  return {
    divisor: positive(source.divisor, DEFAULT_PRICING_RULES.divisor),
    areaThresholds,
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
  const area = Number(widthTai || 0) * Number(heightTai || 0);
  if (!area) return 'BIG';
  if (area <= settings.areaThresholds.smallMax) return 'SMALL';
  if (area <= settings.areaThresholds.regularMax) return 'REGULAR';
  return 'BIG';
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
  const tier = normalizePricingTier(order.machineType || classifyPricingTier(widthTai, lengthTai, state.settings?.moduleInternals?.orders?.pricingRules));

  return (state.priceRules || []).find((rule) => {
    if (String(rule.customer || '').trim().toLowerCase() !== customer) return false;
    if (rule.glossType && glossType && coatingTypeCode(rule.glossType) !== coatingTypeCode(glossType)) return false;
    if (rule.machineType && rule.machineType !== 'ANY' && normalizePricingTier(rule.machineType) !== tier) return false;
    const ruleLength = rule.sizeLengthTai || toTaiInch(rule.sizeLength, rule.sizeUnit);
    const ruleWidth = rule.sizeWidthTai || toTaiInch(rule.sizeWidth, rule.sizeUnit);
    return (closeSize(ruleLength, lengthTai) && closeSize(ruleWidth, widthTai))
      || (closeSize(ruleLength, widthTai) && closeSize(ruleWidth, lengthTai));
  }) || null;
}

export function calculateOrderQuote(state, order = {}) {
  const width = toTaiInch(order.sizeWidth, order.sizeUnit);
  const height = toTaiInch(order.sizeLength, order.sizeUnit);
  const quantity = Number(order.sheetCount || 0);
  const coatingType = coatingTypeCode(order.glossType);
  if (!width || !height || !quantity || !coatingType) return null;

  const settings = normalizePricingRules(state.settings?.moduleInternals?.orders?.pricingRules);
  const tier = normalizePricingTier(order.machineType || classifyPricingTier(width, height, settings));
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
