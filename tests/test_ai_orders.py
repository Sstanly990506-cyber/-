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
        self.assertEqual(result['upstream'], '')
        self.assertEqual(result['model'], 'gpt-5.4-mini')

    def test_uses_fast_image_detail_by_default(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'])
        content = CapturingResponse.payload['input'][0]['content']
        self.assertEqual(content[1]['detail'], 'auto')
        self.assertEqual(CapturingResponse.payload['max_output_tokens'], 900)

    def test_prompt_includes_known_billing_vendors(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'], customer_names=['富盛'])
        prompt = CapturingResponse.payload['input'][0]['content'][0]['text']
        self.assertIn('Known company names', prompt)
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
        self.assertIn('largest or most prominent full company name', ai_orders.BUSINESS_RULES)
        self.assertIn('Never lengthen, autocomplete, or replace it', ai_orders.BUSINESS_RULES)
        self.assertIn('禹利有限公司 must remain 禹利有限公司', ai_orders.BUSINESS_RULES)
        self.assertIn('upstream means the company upstream of 三青', ai_orders.BUSINESS_RULES)
        self.assertIn('separate from billingCustomer', ai_orders.BUSINESS_RULES)
        self.assertIn('廠商', ai_orders.BUSINESS_RULES)
        self.assertIn('HC003', ai_orders.BUSINESS_RULES)
        self.assertIn('客戶代號', ai_orders.BUSINESS_RULES)
        self.assertIn('軋盒', ai_orders.BUSINESS_RULES)
        self.assertIn('軋工', ai_orders.BUSINESS_RULES)
        self.assertIn('row or column labeled 三青', ai_orders.BUSINESS_RULES)
        self.assertIn('sheetCountText is a quantity note/remark field', ai_orders.BUSINESS_RULES)
        self.assertIn('sizeLength maps exactly to 天', ai_orders.BUSINESS_RULES)
        self.assertIn('sizeWidth maps exactly to 地', ai_orders.BUSINESS_RULES)
        self.assertIn('台吋 maps to tai-inch', ai_orders.BUSINESS_RULES)
        self.assertIn('1362車+238張', ai_orders.BUSINESS_RULES)

    def test_customer_list_is_only_an_exact_spelling_hint(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, customer_names=['瑪利電子分色有限公司'])
        prompt = CapturingResponse.payload['input'][0]['content'][0]['text']
        self.assertIn('spelling hints only', prompt)
        self.assertIn('never use fuzzy or partial-name autocomplete', prompt)

    def test_keeps_billing_customer_and_upstream_separate(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '客人A', 'upstream': '上游B'})
        self.assertEqual(result['billingCustomer'], '客人A')
        self.assertEqual(result['upstream'], '上游B')

    def test_customer_code_is_cleared_without_overwriting_other_company(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '富盛', 'upstream': 'H C003', 'notes': []})
        self.assertEqual(result['billingCustomer'], '富盛')
        self.assertEqual(result['upstream'], '')
        self.assertIn('上游客戶', result['notes'][0])

    def test_customer_code_is_cleared_when_no_real_vendor_exists(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': 'HC003', 'upstream': '', 'notes': []})
        self.assertEqual(result['billingCustomer'], '')
        self.assertEqual(result['upstream'], '')
        self.assertIn('內部代號', result['notes'][0])

    def test_downstream_customer_code_is_also_cleared(self):
        result = ai_orders.normalize_recognized_order({'billingCustomer': '客人A', 'upstream': '上游B', 'downstream': 'CLNT001', 'notes': []})
        self.assertEqual(result['billingCustomer'], '客人A')
        self.assertEqual(result['upstream'], '上游B')
        self.assertEqual(result['downstream'], '')
        self.assertIn('下游客戶', result['notes'][0])

    def test_business_rules_do_not_calculate_quantity_expression(self):
        self.assertIn('Do not calculate or simplify quantity expressions', ai_orders.BUSINESS_RULES)
        self.assertIn('1362車+238張 exactly', ai_orders.BUSINESS_RULES)
        self.assertFalse(hasattr(ai_orders, 'calculate_sheet_count'))


if __name__ == '__main__':
    unittest.main()
