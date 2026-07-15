import base64
import difflib
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
MAX_IMAGE_BYTES = 2_500_000
AI_ORDER_RULES_VERSION = '20260715-process-anchor-1'
BUSINESS_RULES = (
    'This system is used by a coating/varnishing factory. '
    'billingCustomer means our customer. Normally use the largest or most prominent full company name at the top of the work order, '
    'especially a name ending in 公司, 有限公司, or 股份有限公司. This is a strong clue, but an explicitly labeled field takes priority. '
    'Preserve the exact visible legal company name. Never lengthen, autocomplete, or replace it with a similar customer-system name. '
    'For example, 禹利電子分色有限公司 must remain exactly 禹利電子分色有限公司 and must not be shortened to 禹利有限公司 '
    'or changed to the similar name 瑪利電子分色有限公司. '
    'First locate the process-table row where the process is 上光 or 上光加工 and the vendor is 三青. This is the 三青 anchor row. '
    'upstream means the company upstream of 三青 and is separate from billingCustomer. Starting at the anchor row, search upward for '
    'the nearest preceding row whose process is 印刷, then copy that row\'s 廠商 as upstream. It is usually a printing company. '
    'Do not use a 製版, 紙張, customer-code, item-code, or 客戶名稱 cell as upstream. '
    'Never copy billingCustomer into upstream merely because one field is missing; set them equal only when the image clearly supports it. '
    'The orderDate field means delivery date / handover date, not issue date. Prefer labels such as 交貨日期, 到貨, 完成寄出, or delivery date. '
    'Ignore 工單日期 and page printing timestamps. Convert a Taiwan ROC year by adding 1911; for example 115/07/31 becomes 2026-07-31. '
    'If only 發單日期/issue date is visible and no delivery date is visible, leave orderDate empty. '
    'Read orderNumber only from a work-order label such as 工單編號, 工單號碼, 工單NO, or work order number; do not use a customer code. '
    'Do not use alphanumeric customer codes or item codes such as HC003, H C003, CLNT001, or similar 客戶代號 as any company name. '
    'For downstream, start at the 三青 anchor row and search downward for the first row explicitly labeled 軋盒, 軋工, 軋合, 軋型, or 裁切, '
    'then copy that row\'s 廠商. Skip 裱紙, 糊工, 刀模, 運送, and 其他 while looking for that next cutting/die-cut process. '
    'Do not treat 三青 or the company on the 上光 row as upstream or downstream. '
    'The address field means the delivery destination after coating, so it belongs to the downstream company. '
    'Never use the document issuer, header, advertising-design company, upstream printing company, or coating-factory address as the delivery address. '
    'Only return an address from the image when it is explicitly identified as the downstream/next-process delivery destination; otherwise leave it empty. '
    'Read quantity only from the 三青 anchor row when that row is available. sheetCountText is a quantity note/remark field: combine the anchor row\'s '
    'item/edition, production specification, quantity, and remark in reading order, copying the complete visible wording. '
    'including Chinese text and symbols, and preserve expressions such as 1362車+238張 exactly. '
    'sheetCount is the explicit true numeric quantity used for calculation. Use the single explicit quantity from the 三青 field when visible. '
    'Do not calculate or simplify quantity expressions; if only an expression is visible and no separate total is printed, set sheetCount to zero. '
    'sizeLength maps exactly to 天 and sizeWidth maps exactly to 地; do not swap or sort them by numeric size. '
    'Preserve the printed size unit: 台吋 maps to tai-inch, mm to mm, cm to cm, and 英吋/吋 to inch. If no unit is visible, leave sizeUnit empty. '
)

REFERENCE_CASES = (
    'Reference case for this exact work-order layout: the largest company name at the top is 鍇樂設計股份有限公司, so billingCustomer is '
    '鍇樂設計股份有限公司. The 上光 row with vendor 三青 is the anchor. The nearest 印刷 row above it has vendor 柏豐, so upstream is 柏豐. '
    'Below the anchor, skip 裱紙 and use the 軋工 row with vendor 泰興, so downstream is 泰興. 工單單號 115070051 means orderNumber '
    '115070051. 交貨日期 115/07/31 means orderDate 2026-07-31. The anchor row reads A版, 單面-A光(油性) 2.37*3.37台尺, '
    '750車, so sheetCountText preserves those words and sheetCount is 750. Never use the header field 客戶名稱 曼秀雷敦(A076) as billingCustomer. '
)


CUSTOMER_CODE_PATTERN = re.compile(r'^[A-Z]{1,5}[-_ ]*\d{2,}$', re.IGNORECASE)
RESPONSE_ID_PATTERN = re.compile(r'^resp_[A-Za-z0-9_-]{8,200}$')
ROC_DATE_PATTERN = re.compile(r'(?<!\d)(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})(?!\d)')
REVIEWABLE_FIELDS = (
    'orderNumber', 'orderDate', 'billingCustomer', 'upstream', 'downstream', 'address',
    'sheetCountText', 'sheetCount', 'sizeLength', 'sizeWidth', 'sizeUnit', 'glossType',
)


def _mark_review_fields(recognized, fields):
    current = recognized.get('reviewFields')
    review_fields = list(current) if isinstance(current, list) else []
    for field in fields:
        if field in REVIEWABLE_FIELDS and field not in review_fields:
            review_fields.append(field)
    recognized['reviewFields'] = review_fields


def _ensure_recognition_review(recognized):
    """Keep older model responses usable while requiring field-level review data."""
    field_confidence = recognized.get('fieldConfidence')
    if not isinstance(field_confidence, dict):
        field_confidence = {}
    fallback = float(recognized.get('confidence') or 0)
    for field in REVIEWABLE_FIELDS:
        try:
            value = float(field_confidence.get(field, fallback))
        except (TypeError, ValueError):
            value = fallback
        field_confidence[field] = max(0.0, min(1.0, value))
    recognized['fieldConfidence'] = field_confidence
    _mark_review_fields(recognized, [])
    return recognized


def _company_key(value):
    return re.sub(r'[\s()（）,，.．_-]+', '', str(value or '')).lower()


def add_recognition_review(recognized, customer_names):
    """Offer possible master-data matches for review, without ever replacing text."""
    if not isinstance(recognized, dict):
        return recognized
    _ensure_recognition_review(recognized)
    names = []
    for name in customer_names or []:
        text = str(name or '').strip()
        if text and text not in names:
            names.append(text)
    candidates_by_field = {}
    for field in ('billingCustomer', 'upstream', 'downstream'):
        value = str(recognized.get(field) or '').strip()
        if not value or not names:
            continue
        value_key = _company_key(value)
        exact = any(_company_key(name) == value_key for name in names)
        if exact:
            continue
        ranked = sorted(
            ((difflib.SequenceMatcher(None, value_key, _company_key(name)).ratio(), name) for name in names),
            key=lambda item: item[0], reverse=True,
        )
        matches = [name for score, name in ranked[:3] if score >= 0.58]
        if matches:
            candidates_by_field[field] = matches
            _mark_review_fields(recognized, [field])
    recognized['customerCandidates'] = candidates_by_field
    if not str(recognized.get('orderDate') or '').strip():
        _mark_review_fields(recognized, ['orderDate'])
    if str(recognized.get('sheetCountText') or '').strip() and not recognized.get('sheetCount'):
        _mark_review_fields(recognized, ['sheetCount'])
    if (recognized.get('sizeLength') or recognized.get('sizeWidth')) and not str(recognized.get('sizeUnit') or '').strip():
        _mark_review_fields(recognized, ['sizeUnit'])
    return recognized


def _looks_like_customer_code(value):
    compact = re.sub(r'\s+', '', str(value or '')).strip()
    if not compact:
        return False
    if CUSTOMER_CODE_PATTERN.fullmatch(compact):
        return True
    has_letter = any(ch.isalpha() for ch in compact)
    has_digit = any(ch.isdigit() for ch in compact)
    has_chinese = any('\u4e00' <= ch <= '\u9fff' for ch in compact)
    return has_letter and has_digit and not has_chinese and len(compact) <= 12


def _normalize_delivery_date(value):
    text = str(value or '').strip()
    match = ROC_DATE_PATTERN.search(text)
    if not match:
        return text
    year, month, day = (int(part) for part in match.groups())
    if year < 100:
        return text
    if year < 1000:
        year += 1911
    try:
        return f'{year:04d}-{month:02d}-{day:02d}' if 1 <= month <= 12 and 1 <= day <= 31 else text
    except ValueError:
        return text


def normalize_recognized_order(recognized):
    if not isinstance(recognized, dict):
        return recognized
    cleared = []
    company_fields = {
        'billingCustomer': '客人',
        'upstream': '上游客戶',
        'downstream': '下游客戶',
    }
    for key, label in company_fields.items():
        value = str(recognized.get(key) or '').strip()
        if _looks_like_customer_code(value):
            recognized[key] = ''
            cleared.append(label)
        else:
            recognized[key] = value
    recognized['orderDate'] = _normalize_delivery_date(recognized.get('orderDate'))
    if cleared:
        notes = recognized.get('notes')
        if not isinstance(notes, list):
            notes = []
        message = f'{"、".join(cleared)}像內部代號，已留空，請選真正的公司名稱。'
        if message not in notes:
            notes.append(message)
        recognized['notes'] = notes
        _mark_review_fields(recognized, [key for key, value in company_fields.items() if not recognized.get(key)])
    return _ensure_recognition_review(recognized)

ORDER_SCHEMA = {
    'type': 'object',
    'properties': {
        'orderNumber': {'type': 'string'},
        'orderDate': {'type': 'string'},
        'billingCustomer': {'type': 'string'},
        'upstream': {'type': 'string'},
        'downstream': {'type': 'string'},
        'address': {'type': 'string'},
        'sheetCountText': {'type': 'string'},
        'sheetCount': {'type': 'number'},
        'sizeLength': {'type': 'number'},
        'sizeWidth': {'type': 'number'},
        'sizeUnit': {'type': 'string', 'enum': ['mm', 'cm', 'inch', 'tai-inch', '']},
        'glossType': {'type': 'string'},
        'totalPrice': {'type': 'number'},
        'confidence': {'type': 'number'},
        'notes': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': [
        'orderNumber', 'orderDate', 'billingCustomer', 'upstream', 'downstream', 'address', 'sheetCountText', 'sheetCount',
        'sizeLength', 'sizeWidth', 'sizeUnit', 'glossType', 'totalPrice', 'confidence', 'notes',
    ],
    'additionalProperties': False,
}


class OrderRecognitionError(RuntimeError):
    pass


def get_order_recognition_status():
    return {
        'configured': bool(os.environ.get('OPENAI_API_KEY', '').strip()),
        'model': os.environ.get('OPENAI_ORDER_MODEL', '').strip() or 'gpt-5.4-mini',
        'rulesVersion': AI_ORDER_RULES_VERSION,
    }


def _validate_image_data_url(data_url):
    value = str(data_url or '')
    if not value.startswith('data:') or ';base64,' not in value:
        raise ValueError('invalid image')
    header, encoded = value.split(',', 1)
    media_type = header[5:].split(';', 1)[0].lower()
    if media_type not in ALLOWED_IMAGE_TYPES:
        raise ValueError('image must be JPEG, PNG, or WebP')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as err:
        raise ValueError('invalid image encoding') from err
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError('圖片壓縮後仍過大，請改用較小或較清晰的圖片。')
    return value


def _extract_output_text(response):
    if isinstance(response.get('output_text'), str) and response['output_text'].strip():
        return response['output_text']
    for item in response.get('output') or []:
        if item.get('type') != 'message':
            continue
        for content in item.get('content') or []:
            if content.get('type') in {'output_text', 'text'} and content.get('text'):
                return content['text']
    raise OrderRecognitionError('AI did not return recognizable order data')


def _correction_examples(corrections):
    examples = []
    # Keep useful recurring corrections without making every request too large.
    for item in (corrections or [])[:8]:
        changes = item.get('changes') if isinstance(item, dict) else None
        if not isinstance(changes, dict):
            continue
        cleaned = {
            key: {'wrong': value.get('wrong'), 'correct': value.get('correct')}
            for key, value in changes.items()
            if isinstance(value, dict) and value.get('wrong') != value.get('correct')
        }
        if cleaned:
            examples.append(cleaned)
    return json.dumps(examples, ensure_ascii=False, separators=(',', ':'))


def _recognized_order_from_response(result, model):
    try:
        recognized = json.loads(_extract_output_text(result))
    except json.JSONDecodeError as err:
        raise OrderRecognitionError('AI 回傳的工單格式無法解析，請重新辨識。') from err
    recognized = normalize_recognized_order(recognized)
    recognized['model'] = model
    return recognized


def recognize_order_image(data_url, gloss_options=None, corrections=None, customer_names=None, precision=True, background=False):
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise OrderRecognitionError('AI 尚未啟用：請先在 Vercel 設定 OPENAI_API_KEY，然後重新部署。')
    image = _validate_image_data_url(data_url)
    model = os.environ.get('OPENAI_ORDER_MODEL', '').strip() or 'gpt-5.4-mini'
    image_detail = os.environ.get('OPENAI_ORDER_IMAGE_DETAIL', '').strip().lower() or ('high' if precision else 'auto')
    if image_detail not in {'auto', 'low', 'high'}:
        image_detail = 'auto'
    gloss_text = ', '.join(str(item) for item in (gloss_options or [])[:30])
    customer_text = ', '.join(str(item) for item in (customer_names or [])[:50] if str(item or '').strip())
    prompt = (
        'Extract a single factory work order from this image. First read the document by regions: header/customer, '
        'upstream supplier, 三青 process row, downstream process row, quantities, and size fields. '
        'Then map only visible values to the JSON fields. Do not invent unreadable values. '
        'Use an empty string or zero when uncertain. orderDate must be YYYY-MM-DD when visible. '
        'Preserve the visible quantity wording and math symbols in sheetCountText. '
        'Put a numeric quantity in sheetCount only when the document separately shows one explicit calculation quantity. '
        f'{BUSINESS_RULES}'
        f'{REFERENCE_CASES}'
        'Sizes must keep their visible unit. confidence must be between 0 and 1. '
        'Assess each field independently. Leave every ambiguous, missing, or weakly visible value empty or zero. '
        f'Known gloss types, when relevant: {gloss_text or "none supplied"}. '
        f'Known company names from our customer system, when visible in the image: {customer_text or "none supplied"}. '
        'These names are spelling hints only. Use one only when the full visible text matches; never use fuzzy or partial-name autocomplete. '
        'Use the following recent human corrections as hints for recurring recognition mistakes, '
        'but only apply them when supported by the current image: '
        f'{_correction_examples(corrections) or "none supplied"}.'
    )
    payload = {
        'model': model,
        'reasoning': {'effort': 'low'},
        'input': [{
            'role': 'user',
            'content': [
                {'type': 'input_text', 'text': prompt},
                {'type': 'input_image', 'image_url': image, 'detail': image_detail},
            ],
        }],
        # Complex tables can consume reasoning tokens before the compact JSON is emitted.
        'max_output_tokens': 3000,
        'text': {
            'format': {
                'type': 'json_schema',
                'name': 'recognized_work_order',
                'schema': ORDER_SCHEMA,
                'strict': True,
            },
        },
    }
    if background:
        payload['background'] = True
        payload['store'] = True
    request = Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urlopen(request, timeout=20 if background else 50) as response:
            result = json.loads(response.read().decode('utf-8'))
    except HTTPError as err:
        try:
            detail = json.loads(err.read().decode('utf-8')).get('error', {}).get('message')
        except Exception:
            detail = None
        messages = {
            400: 'OpenAI 無法處理這張圖片或目前模型設定。',
            401: 'OpenAI API 金鑰無效，請重新設定 OPENAI_API_KEY。',
            403: 'OpenAI API 金鑰沒有使用此模型的權限。',
            404: '設定的 OpenAI 模型不存在或目前無法使用。',
            429: 'OpenAI API 額度不足或請求過多，請檢查帳戶額度後再試。',
        }
        raise OrderRecognitionError(messages.get(err.code) or detail or f'OpenAI 服務錯誤（HTTP {err.code}）') from err
    except (URLError, TimeoutError, json.JSONDecodeError) as err:
        raise OrderRecognitionError('AI 服務連線逾時或暫時無法使用，請稍後再試。') from err
    if background:
        response_id = str(result.get('id') or '')
        if not RESPONSE_ID_PATTERN.fullmatch(response_id):
            raise OrderRecognitionError('AI 未建立辨識工作，請重新嘗試。')
        return {'recognitionId': response_id, 'status': result.get('status') or 'queued', 'model': model}
    return _recognized_order_from_response(result, model)


def get_order_recognition_result(response_id):
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise OrderRecognitionError('AI 尚未啟用：請先在 Vercel 設定 OPENAI_API_KEY，然後重新部署。')
    recognition_id = str(response_id or '').strip()
    if not RESPONSE_ID_PATTERN.fullmatch(recognition_id):
        raise ValueError('invalid recognition id')
    request = Request(
        f'{OPENAI_RESPONSES_URL}/{recognition_id}',
        headers={'Authorization': f'Bearer {api_key}'},
        method='GET',
    )
    try:
        with urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode('utf-8'))
    except HTTPError as err:
        messages = {
            401: 'OpenAI API 金鑰無效，請重新設定 OPENAI_API_KEY。',
            404: '這次 AI 辨識工作已失效，請重新上傳照片。',
            429: 'OpenAI API 額度不足或請求過多，請稍後再試。',
        }
        raise OrderRecognitionError(messages.get(err.code) or f'讀取 AI 辨識結果失敗（HTTP {err.code}）') from err
    except (URLError, TimeoutError, json.JSONDecodeError) as err:
        raise OrderRecognitionError('讀取 AI 辨識結果暫時失敗，系統會保留工作編號供再次查詢。') from err

    status = str(result.get('status') or '')
    if status in {'queued', 'in_progress'}:
        return {'recognitionId': recognition_id, 'status': status, 'pending': True}
    if status != 'completed':
        detail = (result.get('error') or {}).get('message') if isinstance(result.get('error'), dict) else ''
        reason = (result.get('incomplete_details') or {}).get('reason') if isinstance(result.get('incomplete_details'), dict) else ''
        reason_messages = {
            'max_output_tokens': 'AI 辨識內容較複雜，輸出額度不足，請重新辨識。',
            'content_filter': 'AI 無法處理這張圖片的內容，請改用更清楚的工單照片。',
        }
        raise OrderRecognitionError(detail or reason_messages.get(reason) or reason or f'AI 辨識未完成（{status or "unknown"}）')
    model = str(result.get('model') or os.environ.get('OPENAI_ORDER_MODEL', '').strip() or 'gpt-5.4-mini')
    return {
        'recognitionId': recognition_id,
        'status': status,
        'pending': False,
        'order': _recognized_order_from_response(result, model),
    }
