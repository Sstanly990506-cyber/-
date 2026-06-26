"""Quotation rules shared by the API surfaces."""

PRICING_TIERS = {'BIG', 'REGULAR', 'SMALL'}
REAM_TIERS = {'BIG', 'REGULAR'}
COATING_TYPES = {'PVA', 'PVB', 'WEAR', 'PRESS'}

DEFAULT_PRICING_RULES = {
    'divisor': 4680,
    'dimensionThresholds': {
        'small': {'shortMax': 18, 'longMax': 26},
        'regular': {'shortMax': 25, 'longMax': 35},
    },
    'tierPrices': {
        'BIG': {'PVA': 900, 'PVB': 700, 'WEAR': 900, 'PRESS': 850},
        'REGULAR': {'PVA': 850, 'PVB': 650, 'WEAR': 850, 'PRESS': 800},
        'SMALL': {'PVA': 1, 'PVB': 1, 'WEAR': 1, 'PRESS': 1},
    },
    'minimumCharges': {'BIG': 1000, 'REGULAR': 800, 'SMALL': 600},
}


def _positive_number(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return number if number > 0 else float(fallback)


def _normalize_tier_prices(source=None, legacy_base=None):
    source = source if isinstance(source, dict) else {}
    legacy_base = legacy_base if isinstance(legacy_base, dict) else {}
    return {
        tier: {
            coating: _positive_number(
                (source.get(tier) or {}).get(coating),
                _positive_number(legacy_base.get(coating), DEFAULT_PRICING_RULES['tierPrices'][tier][coating]),
            )
            for coating in COATING_TYPES
        }
        for tier in PRICING_TIERS
    }


def normalize_pricing_rules(value=None):
    source = value if isinstance(value, dict) else {}
    dimension_source = source.get('dimensionThresholds') or {}
    dimension_thresholds = {
        'small': {
            'shortMax': _positive_number((dimension_source.get('small') or {}).get('shortMax'), DEFAULT_PRICING_RULES['dimensionThresholds']['small']['shortMax']),
            'longMax': _positive_number((dimension_source.get('small') or {}).get('longMax'), DEFAULT_PRICING_RULES['dimensionThresholds']['small']['longMax']),
        },
        'regular': {
            'shortMax': _positive_number((dimension_source.get('regular') or {}).get('shortMax'), DEFAULT_PRICING_RULES['dimensionThresholds']['regular']['shortMax']),
            'longMax': _positive_number((dimension_source.get('regular') or {}).get('longMax'), DEFAULT_PRICING_RULES['dimensionThresholds']['regular']['longMax']),
        },
    }
    if dimension_thresholds['regular']['shortMax'] < dimension_thresholds['small']['shortMax']:
        dimension_thresholds['regular']['shortMax'] = dimension_thresholds['small']['shortMax']
    if dimension_thresholds['regular']['longMax'] < dimension_thresholds['small']['longMax']:
        dimension_thresholds['regular']['longMax'] = dimension_thresholds['small']['longMax']
    return {
        'divisor': _positive_number(source.get('divisor'), DEFAULT_PRICING_RULES['divisor']),
        'dimensionThresholds': dimension_thresholds,
        'tierPrices': _normalize_tier_prices(source.get('tierPrices'), source.get('basePrices')),
        'minimumCharges': {
            tier: _positive_number((source.get('minimumCharges') or {}).get(tier), DEFAULT_PRICING_RULES['minimumCharges'][tier])
            for tier in PRICING_TIERS
        },
    }


def normalize_coating_type(value):
    text = str(value or '').strip().upper()
    if 'PVA' in text or 'A光' in text:
        return 'PVA'
    if 'PVB' in text or 'B光' in text:
        return 'PVB'
    if '耐磨' in text or text == 'WEAR':
        return 'WEAR'
    if '壓光' in text or text == 'PRESS':
        return 'PRESS'
    return text


def normalize_pricing_tier(value):
    tier = str(value or '').strip().upper()
    if tier == 'SMALL':
        return 'SMALL'
    if tier == 'REGULAR':
        return 'REGULAR'
    return 'BIG'


def classify_pricing_tier(width, height, rules=None):
    settings = normalize_pricing_rules(rules)
    width = float(width or 0)
    height = float(height or 0)
    if width <= 0 or height <= 0:
        return 'BIG'
    short_side = min(width, height)
    long_side = max(width, height)
    if short_side <= settings['dimensionThresholds']['small']['shortMax'] and long_side <= settings['dimensionThresholds']['small']['longMax']:
        return 'SMALL'
    if short_side <= settings['dimensionThresholds']['regular']['shortMax'] and long_side <= settings['dimensionThresholds']['regular']['longMax']:
        return 'REGULAR'
    return 'BIG'


def calculate_quote(payload, rules=None, customer_unit_price=None):
    if not isinstance(payload, dict):
        raise ValueError('invalid quote payload')
    width = _positive_number(payload.get('width'), 0)
    height = _positive_number(payload.get('height'), 0)
    quantity = _positive_number(payload.get('quantity'), 0)
    coating_type = normalize_coating_type(payload.get('coatingType'))
    settings = normalize_pricing_rules(rules)
    tier = normalize_pricing_tier(payload.get('machineType') or classify_pricing_tier(width, height, settings))
    if not width or not height or not quantity:
        raise ValueError('width, height and quantity must be greater than zero')
    if coating_type not in COATING_TYPES:
        raise ValueError('unsupported coatingType')
    if tier not in PRICING_TIERS:
        raise ValueError('unsupported machineType')

    unit_price = _positive_number(customer_unit_price, settings['tierPrices'][tier][coating_type])
    pricing_mode = 'sheet' if tier == 'SMALL' else 'ream'
    if pricing_mode == 'sheet':
        calculated = round(quantity * unit_price)
    else:
        calculated = round((width * height * quantity * unit_price) / (settings['divisor'] * 100))
    minimum = settings['minimumCharges'][tier]
    final = max(calculated, round(minimum))
    return {
        'unitPrice': round(unit_price, 2),
        'calculatedPrice': calculated,
        'finalPrice': final,
        'minimumApplied': calculated < minimum,
        'pricingTier': tier,
        'pricingMode': pricing_mode,
    }
