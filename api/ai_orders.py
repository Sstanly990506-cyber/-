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
    'billingCustomer means our customer. Normally use the largest or most prominent full company name at the top of the work order, '
    'especially a name ending in 公司, 有限公司, or 股份有限公司. This is a strong clue, but an explicitly labeled field takes priority. '
    'Preserve the exact visible legal company name. Never lengthen, autocomplete, or replace it with a similar customer-system name. '
    'For example, 禹利有限公司 must remain 禹利有限公司 and must not become 禹利電子分色有限公司 or 瑪利電子分色有限公司. '
    'upstream means the company upstream of 三青 and is separate from billingCustomer. Read the company labeled 廠商, 供應商, 印刷, '
    'or another printing-vendor label that identifies who supplied the printed sheets to 三青. It is usually a printing company. '
    'Never copy billingCustomer into upstream merely because one field is missing; set them equal only when the image clearly supports it. '
    'The orderDate field means delivery date / handover date, not issue date. Prefer labels such as 交貨日期, 到貨, 完成寄出, or delivery date. '
    'If only 發單日期/issue date is visible and no delivery date is visible, leave orderDate empty. '
    'Read orderNumber only from a work-order label such as 工單編號, 工單號碼, 工單NO, or work order number; do not use a customer code. '
    'Do not use alphanumeric customer codes or item codes such as HC003, H C003, CLNT001, or similar 客戶代號 as any company name. '
    'The downstream customer is the next process after 三青/上光. Prefer a company shown beside 軋盒, 軋工, 軋合, 裁切, 軋型, '
    'or another clearly labeled next-process row. Do not treat 三青 or the company on the 上光 row as upstream or downstream. '
    'The address field means the delivery destination after coating, so it belongs to the downstream company. '
    'Never use the document issuer, header, advertising-design company, upstream printing company, or coating-factory address as the delivery address. '
    'Only return an address from the image when it is explicitly identified as the downstream/next-process delivery destination; otherwise leave it empty. '
    'Read quantity primarily from the row or column labeled 三青. sheetCountText is a quantity note/remark field: copy the complete visible wording, '
    'including Chinese text and symbols, and preserve expressions such as 1362車+238張 exactly. '
    'sheetCount is the explicit true numeric quantity used for calculation. Use the single explicit quantity from the 三青 field when visible. '
    'Do not calculate or simplify quantity expressions; if only an expression is visible and no separate total is printed, set sheetCount to zero. '
    'sizeLength maps exactly to 天 and sizeWidth maps exactly to 地; do not swap or sort them by numeric size. '
    'Preserve the printed size unit: 台吋 maps to tai-inch, mm to mm, cm to cm, and 英吋/吋 to inch. If no unit is visible, leave sizeUnit empty. '
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
    if cleared:
        notes = recognized.get('notes')
        if not isinstance(notes, list):
            notes = []
        message = f'{"、".join(cleared)}像內部代號，已留空，請選真正的公司名稱。'
        if message not in notes:
            notes.append(message)
        recognized['notes'] = notes
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
    customer_text = ', '.join(str(item) for item in (customer_names or [])[:50] if str(item or '').strip())
    prompt = (
        'Extract a single factory work order from this image. Do not invent unreadable values. '
        'Use an empty string or zero when uncertain. orderDate must be YYYY-MM-DD when visible. '
        'Preserve the visible quantity wording and math symbols in sheetCountText. '
        'Put a numeric quantity in sheetCount only when the document separately shows one explicit calculation quantity. '
        f'{BUSINESS_RULES}'
        'Sizes must keep their visible unit. confidence must be between 0 and 1. '
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
        # The strict schema is compact, so a smaller response budget finishes sooner.
        'max_output_tokens': 900,
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
