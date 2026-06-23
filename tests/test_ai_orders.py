import base64
import json
import unittest
from unittest.mock import patch

from api import ai_orders


class FakeResponse:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self):
        order = {
            'orderNumber': 'WO-1', 'orderDate': '2026-06-15', 'billingCustomer': 'Brand Client', 'upstream': '', 'downstream': 'Client',
            'address': '', 'sheetCountText': '10張', 'sheetCount': 10, 'sizeLength': 100, 'sizeWidth': 200, 'sizeUnit': 'mm',
            'glossType': 'PVA光', 'totalPrice': 500, 'confidence': 0.9, 'notes': [],
        }
        return json.dumps({'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(order)}]}]}).encode()


class AiOrderTests(unittest.TestCase):
    def test_rejects_invalid_image(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            with self.assertRaises(ValueError):
                ai_orders.recognize_order_image('not-an-image')

    def test_requires_api_key(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaises(ai_orders.OrderRecognitionError):
                ai_orders.recognize_order_image(image)

    def test_returns_structured_order(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}), patch('api.ai_orders.urlopen', return_value=FakeResponse()):
            result = ai_orders.recognize_order_image(image, ['PVA光'])
        self.assertEqual(result['orderNumber'], 'WO-1')
        self.assertEqual(result['billingCustomer'], 'Brand Client')
        self.assertEqual(result['upstream'], 'Brand Client')
        self.assertEqual(result['model'], 'gpt-5.4-mini')

    def test_correction_examples_only_include_changed_fields(self):
        value = ai_orders._correction_examples([{'changes': {'address': {'wrong': 'A', 'correct': 'B'}, 'sheetCount': {'wrong': 5, 'correct': 5}}}])
        self.assertIn('"address"', value)
        self.assertNotIn('"sheetCount"', value)

    def test_business_rules_match_coating_factory_workflow(self):
        self.assertIn('delivery date / handover date', ai_orders.BUSINESS_RULES)
        self.assertIn('leave orderDate empty', ai_orders.BUSINESS_RULES)
        self.assertIn('upstream customer', ai_orders.BUSINESS_RULES)
        self.assertIn('billing customer', ai_orders.BUSINESS_RULES)
        self.assertIn('Set billingCustomer and upstream to the same value', ai_orders.BUSINESS_RULES)
        self.assertIn('裁切', ai_orders.BUSINESS_RULES)
        self.assertIn('downstream customer', ai_orders.BUSINESS_RULES)
        self.assertIn('1362車+238張', ai_orders.BUSINESS_RULES)

    def test_normalizes_billing_customer_to_upstream(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '客人A', 'upstream': '上游B'})
        self.assertEqual(result['billingCustomer'], '上游B')
        self.assertEqual(result['upstream'], '上游B')

    def test_business_rules_do_not_calculate_quantity_expression(self):
        self.assertIn('Do not calculate or simplify quantity expressions', ai_orders.BUSINESS_RULES)
        self.assertIn('preserve 1362車+238張 exactly', ai_orders.BUSINESS_RULES)
        self.assertFalse(hasattr(ai_orders, 'calculate_sheet_count'))


if __name__ == '__main__':
    unittest.main()
