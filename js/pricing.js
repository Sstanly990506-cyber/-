export const DEFAULT_PRICING_RULES = {
  divisor: 4680,
  basePrices: { PVA: 900, PVB: 700, WEAR: 900, PRESS: 850 },
  smallAreaThreshold: 340,
  smallSizes: ['12x26', '13x18', '14x21', '18x26'],
  smallDiscounts: { PVA: 0.7, PVB: 0.6 },
  minimumCharges: { BIG: 1000, SMALL: 600 },
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

export function normalizePricingRules(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    divisor: positive(source.divisor, DEFAULT_PRICING_RULES.divisor),
    basePrices: Object.fromEntries(Object.entries(DEFAULT_PRICING_RULES.basePrices)
      .map(([key, fallback]) => [key, positive(source.basePrices?.[key], fallback)])),
    smallAreaThreshold: positive(source.smallAreaThreshold, DEFAULT_PRICING_RULES.smallAreaThreshold),
    smallSizes: Array.isArray(source.smallSizes) && source.smallSizes.length
      ? source.smallSizes.map((item) => String(item).trim().toLowerCase().replaceAll('×', 'x')).filter(Boolean)
      : [...DEFAULT_PRICING_RULES.smallSizes],
    smallDiscounts: Object.fromEntries(Object.entries(DEFAULT_PRICING_RULES.smallDiscounts)
      .map(([key, fallback]) => [key, positive(source.smallDiscounts?.[key], fallback)])),
    minimumCharges: Object.fromEntries(Object.entries(DEFAULT_PRICING_RULES.minimumCharges)
      .map(([key, fallback]) => [key, positive(source.minimumCharges?.[key], fallback)])),
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

  return (state.priceRules || []).find((rule) => {
    if (String(rule.customer || '').trim().toLowerCase() !== customer) return false;
    if (rule.glossType && glossType && coatingTypeCode(rule.glossType) !== coatingTypeCode(glossType)) return false;
    if (rule.machineType && rule.machineType !== 'ANY' && rule.machineType !== order.machineType) return false;
    const ruleLength = rule.sizeLengthTai || toTaiInch(rule.sizeLength, rule.sizeUnit);
    const ruleWidth = rule.sizeWidthTai || toTaiInch(rule.sizeWidth, rule.sizeUnit);
    return (closeSize(ruleLength, lengthTai) && closeSize(ruleWidth, widthTai))
      || (closeSize(ruleLength, widthTai) && closeSize(ruleWidth, lengthTai));
  }) || null;
}

function matchesSmallSize(width, height, sizes) {
  const candidates = new Set([`${width}x${height}`, `${height}x${width}`].map((item) => item.replace(/\.0+(?=x|$)/g, '')));
  return sizes.some((size) => candidates.has(String(size).replaceAll(' ', '')));
}

export function calculateOrderQuote(state, order = {}) {
  const width = toTaiInch(order.sizeWidth, order.sizeUnit);
  const height = toTaiInch(order.sizeLength, order.sizeUnit);
  const quantity = Number(order.sheetCount || 0);
  const coatingType = coatingTypeCode(order.glossType);
  const machineType = order.machineType === 'SMALL' ? 'SMALL' : 'BIG';
  if (!width || !height || !quantity || !coatingType) return null;

  const customerRule = findCustomerPriceRule(state, order);
  if (customerRule && customerRule.pricingMode !== 'formula') {
    const finalPrice = Math.round(quantity * Number(customerRule.unitPrice || 0));
    return { unitPrice: Number(customerRule.unitPrice || 0), calculatedPrice: finalPrice, finalPrice, minimumApplied: false, source: 'legacy-customer', customerRule };
  }

  const settings = normalizePricingRules(state.settings?.moduleInternals?.orders?.pricingRules);
  let unitPrice = positive(customerRule?.unitPrice, settings.basePrices[coatingType]);
  const area = width * height;
  const smallDiscountApplied = area < settings.smallAreaThreshold && matchesSmallSize(width, height, settings.smallSizes);
  if (smallDiscountApplied) unitPrice *= settings.smallDiscounts[coatingType] || 1;
  const calculatedPrice = Math.round((width * height * quantity * unitPrice) / (settings.divisor * 100));
  const minimum = settings.minimumCharges[machineType];
  return {
    unitPrice: Math.round(unitPrice * 100) / 100,
    calculatedPrice,
    finalPrice: Math.max(calculatedPrice, Math.round(minimum)),
    minimumApplied: calculatedPrice < minimum,
    smallDiscountApplied,
    source: customerRule ? 'customer-formula' : 'default-formula',
    customerRule,
  };
}

export function estimateOrderPriceFromRule(rule, sheetCount) {
  const count = Number(sheetCount || 0);
  const unitPrice = Number(rule?.unitPrice || 0);
  if (!rule || !count || !unitPrice) return 0;
  return Math.round(count * unitPrice);
}
