import unittest

from api.pricing import calculate_quote


class PricingTests(unittest.TestCase):
    def test_example_formula(self):
        result = calculate_quote({
            'width': 26,
            'height': 18,
            'quantity': 1000,
            'coatingType': 'PVA',
            'machineType': 'BIG',
        })
        self.assertEqual(result['unitPrice'], 900)
        self.assertEqual(result['calculatedPrice'], 900)
        self.assertEqual(result['finalPrice'], 1000)
        self.assertTrue(result['minimumApplied'])
        self.assertEqual(result['pricingTier'], 'BIG')
        self.assertEqual(result['pricingMode'], 'ream')

    def test_small_tier_uses_per_sheet_price(self):
        result = calculate_quote({
            'width': 12,
            'height': 26,
            'quantity': 10,
            'coatingType': 'PVA',
            'machineType': 'SMALL',
        }, {'tierPrices': {'SMALL': {'PVA': 2}}})
        self.assertEqual(result['unitPrice'], 2)
        self.assertEqual(result['calculatedPrice'], 20)
        self.assertEqual(result['finalPrice'], 600)
        self.assertTrue(result['minimumApplied'])
        self.assertEqual(result['pricingMode'], 'sheet')

    def test_customer_price_overrides_base_price(self):
        result = calculate_quote({
            'width': 26,
            'height': 18,
            'quantity': 1000,
            'coatingType': 'PVB',
            'machineType': 'BIG',
        }, customer_unit_price=800)
        self.assertEqual(result['unitPrice'], 800)
        self.assertEqual(result['calculatedPrice'], 800)
        self.assertEqual(result['finalPrice'], 1000)

    def test_regular_tier_has_separate_ream_price(self):
        result = calculate_quote({
            'width': 20,
            'height': 20,
            'quantity': 1000,
            'coatingType': 'PVA',
            'machineType': 'REGULAR',
        })
        self.assertEqual(result['unitPrice'], 850)
        self.assertEqual(result['pricingTier'], 'REGULAR')
        self.assertEqual(result['pricingMode'], 'ream')
        self.assertEqual(result['finalPrice'], 800)

    def test_area_thresholds_can_classify_tier(self):
        result = calculate_quote({
            'width': 12,
            'height': 20,
            'quantity': 100,
            'coatingType': 'PVB',
        }, {'areaThresholds': {'smallMax': 250, 'regularMax': 500}})
        self.assertEqual(result['pricingTier'], 'SMALL')
        self.assertEqual(result['pricingMode'], 'sheet')

    def test_custom_settings_are_applied(self):
        result = calculate_quote({
            'width': 10,
            'height': 10,
            'quantity': 1,
            'coatingType': 'PRESS',
            'machineType': 'BIG',
        }, {'minimumCharges': {'BIG': 1500}})
        self.assertEqual(result['finalPrice'], 1500)
        self.assertTrue(result['minimumApplied'])
