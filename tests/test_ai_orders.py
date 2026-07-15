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


class BackgroundResponse:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self):
        return json.dumps({
            'id': 'resp_test12345678',
            'status': 'queued',
            'model': 'gpt-5.4-mini',
        }).encode()


class CompletedBackgroundResponse(FakeResponse):
    def read(self):
        result = json.loads(super().read().decode('utf-8'))
        result.update({
            'id': 'resp_test12345678',
            'status': 'completed',
            'model': 'gpt-5.4-mini',
        })
        return json.dumps(result).encode()


class IncompleteBackgroundResponse:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self):
        return json.dumps({
            'id': 'resp_test12345678',
            'status': 'incomplete',
            'incomplete_details': {'reason': 'max_output_tokens'},
        }).encode()


def capture_background_request(request, timeout=None):
    CapturingResponse.payload = json.loads(request.data.decode('utf-8'))
    return BackgroundResponse()


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

    def test_starts_background_recognition(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}), patch('api.ai_orders.urlopen', side_effect=capture_background_request):
            result = ai_orders.recognize_order_image(image, background=True)
        self.assertEqual(result['recognitionId'], 'resp_test12345678')
        self.assertEqual(result['status'], 'queued')
        self.assertTrue(CapturingResponse.payload['background'])
        self.assertTrue(CapturingResponse.payload['store'])

    def test_reads_completed_background_recognition(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}), patch('api.ai_orders.urlopen', return_value=CompletedBackgroundResponse()):
            result = ai_orders.get_order_recognition_result('resp_test12345678')
        self.assertFalse(result['pending'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['order']['orderNumber'], 'WO-1')

    def test_explains_incomplete_background_recognition(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}), patch('api.ai_orders.urlopen', return_value=IncompleteBackgroundResponse()):
            with self.assertRaises(ai_orders.OrderRecognitionError) as caught:
                ai_orders.get_order_recognition_result('resp_test12345678')
        self.assertIn('輸出額度不足', str(caught.exception))

    def test_uses_high_image_detail_for_precision_by_default(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image, ['PVA光'])
        content = CapturingResponse.payload['input'][0]['content']
        self.assertEqual(content[1]['detail'], 'high')
        self.assertEqual(CapturingResponse.payload['max_output_tokens'], 3000)

    def test_precision_review_is_added_after_the_compact_model_response(self):
        self.assertNotIn('fieldConfidence', ai_orders.ORDER_SCHEMA['properties'])
        self.assertNotIn('reviewFields', ai_orders.ORDER_SCHEMA['properties'])
        result = ai_orders.normalize_recognized_order({'orderNumber': 'WO-1', 'confidence': 0.8})
        self.assertEqual(set(result['fieldConfidence']), set(ai_orders.REVIEWABLE_FIELDS))
        self.assertEqual(result['reviewFields'], [])

    def test_customer_candidate_requires_review_and_never_replaces_visible_text(self):
        recognized = {'billingCustomer': '禹利電子分色有限公司', 'confidence': 0.9}
        result = ai_orders.add_recognition_review(recognized, ['瑪利電子分色有限公司', '禹利電子分色有限公'])
        self.assertEqual(result['billingCustomer'], '禹利電子分色有限公司')
        self.assertIn('billingCustomer', result['reviewFields'])
        self.assertEqual(result['customerCandidates']['billingCustomer'][0], '禹利電子分色有限公')

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
        self.assertIn('禹利電子分色有限公司 must remain exactly 禹利電子分色有限公司', ai_orders.BUSINESS_RULES)
        self.assertIn('must not be shortened to 禹利有限公司', ai_orders.BUSINESS_RULES)
        self.assertIn('upstream means the company upstream of 三青', ai_orders.BUSINESS_RULES)
        self.assertIn('separate from billingCustomer', ai_orders.BUSINESS_RULES)
        self.assertIn('廠商', ai_orders.BUSINESS_RULES)
        self.assertIn('HC003', ai_orders.BUSINESS_RULES)
        self.assertIn('客戶代號', ai_orders.BUSINESS_RULES)
        self.assertIn('軋盒', ai_orders.BUSINESS_RULES)
        self.assertIn('軋工', ai_orders.BUSINESS_RULES)
        self.assertIn('Read quantity only from the 三青 anchor row', ai_orders.BUSINESS_RULES)
        self.assertIn('sheetCountText is a quantity note/remark field', ai_orders.BUSINESS_RULES)
        self.assertIn('sizeLength maps exactly to 天', ai_orders.BUSINESS_RULES)
        self.assertIn('sizeWidth maps exactly to 地', ai_orders.BUSINESS_RULES)
        self.assertIn('台吋 maps to tai-inch', ai_orders.BUSINESS_RULES)
        self.assertIn('1362車+238張', ai_orders.BUSINESS_RULES)
        self.assertIn('三青 anchor row', ai_orders.BUSINESS_RULES)
        self.assertIn('nearest preceding row whose process is 印刷', ai_orders.BUSINESS_RULES)
        self.assertIn('Skip 裱紙, 糊工, 刀模, 運送, and 其他', ai_orders.BUSINESS_RULES)

    def test_prompt_contains_process_anchor_reference_case(self):
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'image').decode()
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}, clear=True), patch('api.ai_orders.urlopen', side_effect=capture_request):
            ai_orders.recognize_order_image(image)
        prompt = CapturingResponse.payload['input'][0]['content'][0]['text']
        self.assertIn('鍇樂設計股份有限公司', prompt)
        self.assertIn('upstream is 柏豐', prompt)
        self.assertIn('downstream is 泰興', prompt)
        self.assertIn('orderNumber 115070051', prompt)
        self.assertIn('orderDate 2026-07-31', prompt)
        self.assertIn('sheetCount is 750', prompt)

    def test_normalizes_roc_delivery_date_for_html_date_field(self):
        result = ai_orders.normalize_recognized_order({'orderDate': '115-07-31（五）'})
        self.assertEqual(result['orderDate'], '2026-07-31')

    def test_recognition_status_exposes_rules_version(self):
        status = ai_orders.get_order_recognition_status()
        self.assertEqual(status['rulesVersion'], '20260715-process-anchor-1')

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
