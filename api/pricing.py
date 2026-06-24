"""Quotation rules shared by the API surfaces."""

DEFAULT_PRICING_RULES = {
    'divisor': 4680,
    'basePrices': {'PVA': 900, 'PVB': 700, 'WEAR': 900, 'PRESS': 850},
    'smallAreaThreshold': 340,
    'smallSizes': ['12x26', '13x18', '14x21', '18x26'],
    'smallDiscounts': {'PVA': 0.7, 'PVB': 0.6},
    'minimumCharges': {'BIG': 1000, 'SMALL': 600},
}

COATING_TYPES = {'PVA', 'PVB', 'WEAR', 'PRESS'}
MACHINE_TYPES = {'BIG', 'SMALL'}


def _positive_number(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return number if number > 0 else float(fallback)


def normalize_pricing_rules(value=None):
    source = value if isinstance(value, dict) else {}
    defaults = DEFAULT_PRICING_RULES
    return {
        'divisor': _positive_number(source.get('divisor'), defaults['divisor']),
        'basePrices': {
            key: _positive_number((source.get('basePrices') or {}).get(key), defaults['basePrices'][key])
            for key in COATING_TYPES
        },
        'smallAreaThreshold': _positive_number(source.get('smallAreaThreshold'), defaults['smallAreaThreshold']),
        'smallSizes': [
            str(item).strip().lower().replace('×', 'x')
            for item in (source.get('smallSizes') or defaults['smallSizes'])
            if str(item).strip()
        ],
        'smallDiscounts': {
            key: _positive_number((source.get('smallDiscounts') or {}).get(key), defaults['smallDiscounts'][key])
            for key in defaults['smallDiscounts']
        },
        'minimumCharges': {
            key: _positive_number((source.get('minimumCharges') or {}).get(key), defaults['minimumCharges'][key])
            for key in MACHINE_TYPES
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


def _matches_small_size(width, height, sizes):
    candidates = {f'{width:g}x{height:g}', f'{height:g}x{width:g}'}
    return any(str(size).replace(' ', '') in candidates for size in sizes)


def calculate_quote(payload, rules=None, customer_unit_price=None):
    if not isinstance(payload, dict):
        raise ValueError('invalid quote payload')
    width = _positive_number(payload.get('width'), 0)
    height = _positive_number(payload.get('height'), 0)
    quantity = _positive_number(payload.get('quantity'), 0)
    coating_type = normalize_coating_type(payload.get('coatingType'))
    machine_type = str(payload.get('machineType') or '').strip().upper()
    if not width or not height or not quantity:
        raise ValueError('width, height and quantity must be greater than zero')
    if coating_type not in COATING_TYPES:
        raise ValueError('unsupported coatingType')
    if machine_type not in MACHINE_TYPES:
        raise ValueError('unsupported machineType')

    settings = normalize_pricing_rules(rules)
    unit_price = _positive_number(customer_unit_price, settings['basePrices'][coating_type])
    area = width * height
    if area < settings['smallAreaThreshold'] and _matches_small_size(width, height, settings['smallSizes']):
        unit_price *= settings['smallDiscounts'].get(coating_type, 1)

    calculated = round((width * height * quantity * unit_price) / (settings['divisor'] * 100))
    minimum = settings['minimumCharges'][machine_type]
    final = max(calculated, round(minimum))
    return {
        'unitPrice': round(unit_price, 2),
        'calculatedPrice': calculated,
        'finalPrice': final,
        'minimumApplied': calculated < minimum,
    }
