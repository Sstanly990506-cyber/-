import base64
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
MAX_IMAGE_BYTES = 2_500_000
BUSINESS_RULES = (
    'This system is used by a coating/varnishing factory. '
    'The orderDate field means delivery date / handover date, not issue date. Prefer labels such as 交貨日期, 到貨, 完成寄出, or delivery date. '
    'If only 發單日期/issue date is visible and no delivery date is visible, leave orderDate empty. '
    'The billing customer and upstream customer must be the same printing factory/vendor because the upstream vendor is who we bill. '
    'Set billingCustomer and upstream to the same value. Prefer the upstream/printing company/vendor that sends printed sheets to us, '
    'or the visible customer field when it clearly identifies a real company name that should be billed. '
    'Do not use alphanumeric customer codes or item codes such as HC003, H C003, CLNT001, or similar 客戶代號 as billingCustomer/upstream. '
    'On outsourced processing forms such as 鼎易/鼎義 委外加工單, the 客戶 field can be the issuer printer/vendor customer, not our customer. '
    'For those forms, if 富盛 is visible, use 富盛 as billingCustomer and upstream instead of HC003. '
    'The downstream customer is normally the company shown on a process after 上光, especially 裁切, 軋合, 軋型, or similar finishing rows. '
    'Do not treat the company on the 上光 row as upstream or downstream because that row commonly identifies our own factory. '
    'The address field means the delivery destination after coating, so it belongs to the downstream company. '
    'Never use the document issuer, header, advertising-design company, upstream printing company, or coating-factory address as the delivery address. '
    'Only return an address from the image when it is explicitly identified as the downstream/next-process delivery destination; otherwise leave it empty. '
    'Read quantity primarily from the 印刷 row, preserving expressions such as 1362車+238張 in sheetCountText. '
    'Do not calculate or simplify quantity expressions. For example, preserve 1362車+238張 exactly and set sheetCount to zero '
    'unless the document separately shows one explicit numeric calculation quantity. '
    'Do not prefer 訂購數量 or 紙張 row quantity when a more specific 印刷 row quantity exists. '
)


CUSTOMER_CODE_PATTERN = re.compile(r'^[A-Z]{1,5}[-_ ]*\d{2,}$', re.IGNORECASE)


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


def normalize_recognized_order(recognized):
    if not isinstance(recognized, dict):
        return recognized
    billing = str(recognized.get('billingCustomer') or '').strip()
    upstream = str(recognized.get('upstream') or '').strip()
    billing_is_code = _looks_like_customer_code(billing)
    upstream_is_code = _looks_like_customer_code(upstream)
    if upstream_is_code and billing and not billing_is_code:
        customer = billing
    elif billing_is_code and upstream and not upstream_is_code:
        customer = upstream
    elif billing_is_code or upstream_is_code:
        customer = ''
        notes = recognized.get('notes')
        if not isinstance(notes, list):
            notes = []
        notes.append('客人/上游客戶像內部代號，已留空，請改選真正交紙給我們的上游廠商。')
        recognized['notes'] = notes
    else:
        customer = upstream or billing
    recognized['billingCustomer'] = customer
    recognized['upstream'] = customer
    return recognized

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
    for item in response.get('output') or []:
        if item.get('type') != 'message':
            continue
        for content in item.get('content') or []:
            if content.get('type') == 'output_text' and content.get('text'):
                return content['text']
    raise OrderRecognitionError('AI did not return recognizable order data')


def _correction_examples(corrections):
    examples = []
    for item in (corrections or [])[:20]:
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


def recognize_order_image(data_url, gloss_options=None, corrections=None, customer_names=None):
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise OrderRecognitionError('AI 尚未啟用：請先在 Vercel 設定 OPENAI_API_KEY，然後重新部署。')
    image = _validate_image_data_url(data_url)
    model = os.environ.get('OPENAI_ORDER_MODEL', '').strip() or 'gpt-5.4-mini'
    image_detail = os.environ.get('OPENAI_ORDER_IMAGE_DETAIL', '').strip().lower() or 'auto'
    if image_detail not in {'auto', 'low', 'high'}:
        image_detail = 'auto'
    gloss_text = ', '.join(str(item) for item in (gloss_options or [])[:30])
    customer_text = ', '.join(str(item) for item in (customer_names or [])[:80] if str(item or '').strip())
    prompt = (
        'Extract a single factory work order from this image. Do not invent unreadable values. '
        'Use an empty string or zero when uncertain. orderDate must be YYYY-MM-DD when visible. '
        'Preserve the visible quantity wording and math symbols in sheetCountText. '
        'Put a numeric quantity in sheetCount only when the document separately shows one explicit calculation quantity. '
        f'{BUSINESS_RULES}'
        'Sizes must keep their visible unit. confidence must be between 0 and 1. '
        f'Known gloss types, when relevant: {gloss_text or "none supplied"}. '
        f'Known billing/upstream vendors from our customer system, when visible in the image: {customer_text or "none supplied"}. '
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
        'max_output_tokens': 1200,
        'text': {
            'format': {
                'type': 'json_schema',
                'name': 'recognized_work_order',
                'schema': ORDER_SCHEMA,
                'strict': True,
            },
        },
    }
    request = Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urlopen(request, timeout=50) as response:
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
    try:
        recognized = json.loads(_extract_output_text(result))
    except json.JSONDecodeError as err:
        raise OrderRecognitionError('AI returned invalid order data') from err
    recognized = normalize_recognized_order(recognized)
    recognized['model'] = model
    return recognized
