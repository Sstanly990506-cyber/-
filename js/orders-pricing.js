import { normalizePricingTier } from './pricing.js';

export const COATING_LABELS = {
  PVA: 'PVA光',
  PVB: 'PVB光/油',
  WEAR: '耐磨',
  PRESS: '壓光',
};

export function formatRuleSize(rule) {
  const hasLength = Number(rule.sizeLengthTai || rule.sizeLength || 0);
  const hasWidth = Number(rule.sizeWidthTai || rule.sizeWidth || 0);
  if (!hasLength && !hasWidth) return '全部尺寸';
  return `天 ${Number(rule.sizeLength || 0).toLocaleString()} x 地 ${Number(rule.sizeWidth || 0).toLocaleString()} ${rule.sizeUnit || 'mm'}`;
}

export function pricingTierLabel(value) {
  const tier = normalizePricingTier(value);
  if (tier === 'SMALL') return '小台';
  if (tier === 'REGULAR') return '常規';
  return '大台';
}

export function isCustomerTierPriceRule(rule) {
  if (rule?.priceScope === 'customer-tier-bounds') return false;
  return rule?.priceScope === 'customer-tier'
    || (!Number(rule?.sizeLengthTai || rule?.sizeLength || 0) && !Number(rule?.sizeWidthTai || rule?.sizeWidth || 0));
}

export function isCustomerPricingConfigRule(rule) {
  return rule?.priceScope === 'customer-tier-bounds' || isCustomerTierPriceRule(rule);
}
