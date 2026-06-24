import unittest

from api.pricing import calculate_quote


class PricingTests(unittest.TestCase):
    def test_example_formula(self):
        result = calculate_quote({
            'width': 26,
            'height': 18,
            'quantity': 1000,
            'coatingType': 'PVA',
            'machineType': 'SMALL',
        })
        self.assertEqual(result['unitPrice'], 900)
        self.assertEqual(result['calculatedPrice'], 900)
        self.assertEqual(result['finalPrice'], 900)
        self.assertFalse(result['minimumApplied'])

    def test_small_pva_discount_and_small_machine_minimum(self):
        result = calculate_quote({
            'width': 12,
            'height': 26,
            'quantity': 10,
            'coatingType': 'PVA',
            'machineType': 'SMALL',
        })
        self.assertEqual(result['unitPrice'], 630)
        self.assertLess(result['calculatedPrice'], 600)
        self.assertEqual(result['finalPrice'], 600)
        self.assertTrue(result['minimumApplied'])

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
