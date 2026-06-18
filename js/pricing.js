export function toTaiInch(value, unit = 'mm') {
  const num = Number(value || 0);
  if (!num) return 0;
  const mm = unit === 'cm' ? num * 10 : unit === 'inch' ? num * 25.4 : unit === 'tai-inch' ? num * 30.3 : num;
  return mm / 30.3;
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
    const ruleCustomer = String(rule.customer || '').trim().toLowerCase();
    if (ruleCustomer !== customer) return false;
    if (rule.glossType && glossType && rule.glossType !== glossType) return false;
    const ruleLength = toTaiInch(rule.sizeLength, rule.sizeUnit);
    const ruleWidth = toTaiInch(rule.sizeWidth, rule.sizeUnit);
    return (closeSize(ruleLength, lengthTai) && closeSize(ruleWidth, widthTai))
      || (closeSize(ruleLength, widthTai) && closeSize(ruleWidth, lengthTai));
  }) || null;
}

export function estimateOrderPriceFromRule(rule, sheetCount) {
  const count = Number(sheetCount || 0);
  const unitPrice = Number(rule?.unitPrice || 0);
  if (!rule || !count || !unitPrice) return 0;
  return Math.round(count * unitPrice);
}
