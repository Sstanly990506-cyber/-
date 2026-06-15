import base64
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
MAX_IMAGE_BYTES = 2_500_000

ORDER_SCHEMA = {
    'type': 'object',
    'properties': {
        'orderNumber': {'type': 'string'},
        'orderDate': {'type': 'string'},
        'upstream': {'type': 'string'},
        'downstream': {'type': 'string'},
        'address': {'type': 'string'},
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
        'orderNumber', 'orderDate', 'upstream', 'downstream', 'address', 'sheetCount',
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


def recognize_order_image(data_url, gloss_options=None, corrections=None):
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not api_key:
        raise OrderRecognitionError('AI 尚未啟用：請先在 Vercel 設定 OPENAI_API_KEY，然後重新部署。')
    image = _validate_image_data_url(data_url)
    model = os.environ.get('OPENAI_ORDER_MODEL', '').strip() or 'gpt-5.4-mini'
    gloss_text = ', '.join(str(item) for item in (gloss_options or [])[:30])
    prompt = (
        'Extract a single factory work order from this image. Do not invent unreadable values. '
        'Use an empty string or zero when uncertain. orderDate must be YYYY-MM-DD when visible. '
        'Determine whether customer names are upstream or downstream only when the document makes it clear. '
        'Sizes must keep their visible unit. confidence must be between 0 and 1. '
        f'Known gloss types, when relevant: {gloss_text or "none supplied"}. '
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
                {'type': 'input_image', 'image_url': image, 'detail': 'high'},
            ],
        }],
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
    recognized['model'] = model
    return recognized
