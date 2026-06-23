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


class CapturingResponse(FakeResponse):
    payload = None


def capture_request(request, timeout=None):
    CapturingResponse.payload = json.loads(request.data.decode('utf-8'))
    return CapturingResponse()


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

    def test_uses_fast_image_detail_by_default(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'])
        content = CapturingResponse.payload['input'][0]['content']
        self.assertEqual(content[1]['detail'], 'auto')
        self.assertEqual(CapturingResponse.payload['max_output_tokens'], 1200)

    def test_prompt_includes_known_billing_vendors(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'], customer_names=['富盛'])
        prompt = CapturingResponse.payload['input'][0]['content'][0]['text']
        self.assertIn('Known billing/upstream vendors', prompt)
        self.assertIn('富盛', prompt)

    def test_allows_high_detail_when_configured(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key', 'OPENAI_ORDER_IMAGE_DETAIL': 'high'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'])
        content = CapturingResponse.payload['input'][0]['content']
        self.assertEqual(content[1]['detail'], 'high')

    def test_correction_examples_only_include_changed_fields(self):
        value = ai_orders._correction_examples([{'changes': {'address': {'wrong': 'A', 'correct': 'B'}, 'sheetCount': {'wrong': 5, 'correct': 5}}}])
        self.assertIn('"address"', value)
        self.assertNotIn('"sheetCount"', value)

    def test_business_rules_match_coating_factory_workflow(self):
        self.assertIn('delivery date / handover date', ai_orders.BUSINESS_RULES)
        self.assertIn('leave orderDate empty', ai_orders.BUSINESS_RULES)
        self.assertIn('upstream customer', ai_orders.BUSINESS_RULES)
        self.assertIn('billing customer', ai_orders.BUSINESS_RULES)
        self.assertIn('upstream vendor is who we bill', ai_orders.BUSINESS_RULES)
        self.assertIn('Set billingCustomer and upstream to the same value', ai_orders.BUSINESS_RULES)
        self.assertIn('HC003', ai_orders.BUSINESS_RULES)
        self.assertIn('富盛', ai_orders.BUSINESS_RULES)
        self.assertIn('客戶代號', ai_orders.BUSINESS_RULES)
        self.assertIn('裁切', ai_orders.BUSINESS_RULES)
        self.assertIn('downstream customer', ai_orders.BUSINESS_RULES)
        self.assertIn('1362車+238張', ai_orders.BUSINESS_RULES)

    def test_normalizes_billing_customer_to_upstream(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '客人A', 'upstream': '上游B'})
        self.assertEqual(result['billingCustomer'], '上游B')
        self.assertEqual(result['upstream'], '上游B')

    def test_customer_code_does_not_override_real_vendor(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '富盛', 'upstream': 'H C003', 'notes': []})
        self.assertEqual(result['billingCustomer'], '富盛')
        self.assertEqual(result['upstream'], '富盛')

    def test_customer_code_is_cleared_when_no_real_vendor_exists(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': 'HC003', 'upstream': '', 'notes': []})
        self.assertEqual(result['billingCustomer'], '')
        self.assertEqual(result['upstream'], '')
        self.assertIn('內部代號', result['notes'][0])

    def test_business_rules_do_not_calculate_quantity_expression(self):
        self.assertIn('Do not calculate or simplify quantity expressions', ai_orders.BUSINESS_RULES)
        self.assertIn('preserve 1362車+238張 exactly', ai_orders.BUSINESS_RULES)
        self.assertFalse(hasattr(ai_orders, 'calculate_sheet_count'))


if __name__ == '__main__':
    unittest.main()
