"""LINE Messaging API integration.

The webhook must verify LINE's signature against the raw request body. Push and
reply calls intentionally use urllib so the app does not need another runtime
dependency on Vercel or the local server.
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

from api.records import list_records, upsert_record

LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply'
LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'
LINE_DESTINATION_ENTITY = 'lineDestinations'


class LineBotError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def line_is_configured():
    return bool(_channel_secret() and _channel_access_token())


def line_status_payload():
    destinations = _active_destinations()
    return {
        'ok': True,
        'configured': line_is_configured(),
        'destinationCount': len(destinations),
        'destinations': [
            {
                'id': row.get('id'),
                'type': row.get('type') or 'user',
                'label': row.get('label') or _mask_destination(row.get('destinationId') or row.get('id')),
                'lastSeenAt': row.get('lastSeenAt') or '',
            }
            for row in destinations[:20]
        ],
    }


def send_line_message(text=None):
    if not line_is_configured():
        raise LineBotError('LINE 尚未設定 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN', 503)
    message = _trim_text(text or _build_system_reminder())
    destinations = _active_destinations()
    if not destinations:
        raise LineBotError('尚未綁定任何 LINE 聊天室，請先在 LINE 對官方帳號輸入「綁定」。', 400)
    sent = []
    failed = []
    for row in destinations:
        destination = row.get('destinationId') or row.get('id')
        try:
            _line_api_post(LINE_PUSH_URL, {'to': destination, 'messages': [{'type': 'text', 'text': message}]})
            sent.append(row.get('id') or destination)
        except LineBotError as err:
            failed.append({'id': row.get('id') or destination, 'error': str(err)})
    return {'ok': not failed, 'sent': len(sent), 'failed': failed, 'message': message}


def handle_line_webhook(raw_body, signature):
    body = raw_body if isinstance(raw_body, bytes) else bytes(raw_body or b'')
    if not line_is_configured():
        raise LineBotError('LINE integration is not configured', 503)
    if not _verify_signature(body, signature or ''):
        raise LineBotError('invalid LINE signature', 403)
    try:
        payload = json.loads(body.decode('utf-8') or '{}')
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise LineBotError('invalid LINE webhook payload', 400) from err
    events = payload.get('events') if isinstance(payload, dict) else []
    if not isinstance(events, list):
        raise LineBotError('invalid LINE webhook events', 400)
    handled = 0
    for event in events:
        if isinstance(event, dict):
            _handle_event(event)
            handled += 1
    return {'ok': True, 'handled': handled}


def _channel_secret():
    return os.environ.get('LINE_CHANNEL_SECRET', '').strip()


def _channel_access_token():
    return os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '').strip()


def _verify_signature(body, signature):
    digest = hmac.new(_channel_secret().encode('utf-8'), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode('ascii')
    return hmac.compare_digest(expected, str(signature or '').strip())


def _line_api_post(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            'Authorization': f'Bearer {_channel_access_token()}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            response.read()
            return {'status': response.status}
    except urllib.error.HTTPError as err:
        detail = err.read().decode('utf-8', errors='replace')
        raise LineBotError(f'LINE API HTTP {err.code}: {detail}', err.code) from err
    except urllib.error.URLError as err:
        raise LineBotError(f'LINE API 連線失敗：{err.reason}', 502) from err


def _handle_event(event):
    source = event.get('source') or {}
    destination_id, destination_type = _source_destination(source)
    if destination_id:
        _save_destination(destination_id, destination_type, event)
    reply_token = event.get('replyToken')
    if event.get('type') in {'follow', 'join'} and reply_token:
        _reply(reply_token, '已連線到三青系統。輸入「綁定」可接收系統通知，輸入「狀態」可查目前摘要。')
        return
    if event.get('type') != 'message' or (event.get('message') or {}).get('type') != 'text':
        return
    text = str((event.get('message') or {}).get('text') or '').strip()
    response = _build_reply_text(text, destination_id, destination_type)
    if reply_token and response:
        _reply(reply_token, response)


def _source_destination(source):
    if source.get('groupId'):
        return source.get('groupId'), 'group'
    if source.get('roomId'):
        return source.get('roomId'), 'room'
    if source.get('userId'):
        return source.get('userId'), 'user'
    return '', ''


def _save_destination(destination_id, destination_type, event):
    now = int(time.time() * 1000)
    upsert_record(LINE_DESTINATION_ENTITY, destination_id, {
        'id': destination_id,
        'destinationId': destination_id,
        'type': destination_type or 'user',
        'label': _mask_destination(destination_id),
        'active': True,
        'lastEventType': event.get('type') or '',
        'lastSeenAt': now,
        'createdAt': now,
    })


def _active_destinations():
    rows = list_records(LINE_DESTINATION_ENTITY, 1, 100).get('items') or []
    return [row for row in rows if row.get('active') is not False and (row.get('destinationId') or row.get('id'))]


def _reply(reply_token, text):
    _line_api_post(LINE_REPLY_URL, {
        'replyToken': reply_token,
        'messages': [{'type': 'text', 'text': _trim_text(text)}],
    })


def _build_reply_text(text, destination_id='', destination_type='user'):
    normalized = text.replace(' ', '').lower()
    if normalized in {'綁定', 'bind', '加入通知'}:
        label = _mask_destination(destination_id)
        return f'已綁定此 LINE {destination_type or "user"}：{label}\n之後系統可主動推送提醒到這裡。'
    if normalized in {'狀態', 'status', '系統狀態'}:
        return _build_status_summary()
    if normalized in {'提醒', '通知', '財經', 'line提醒'}:
        return _build_system_reminder()
    return '可用指令：\n- 綁定：接收系統推播\n- 狀態：查看工單/客戶/財務摘要\n- 提醒：查看目前需要注意事項'


def _build_status_summary():
    counts = _safe_counts()
    return (
        '【三青系統狀態】\n'
        f'工單：{counts["orders"]} 筆\n'
        f'客戶：{counts["customers"]} 筆\n'
        f'應收：{counts["receivables"]} 筆\n'
        f'應付：{counts["payables"]} 筆\n'
        f'通知目的地：{counts["lineDestinations"]} 個'
    )


def _build_system_reminder():
    orders = list_records('orders', 1, 100).get('items') or []
    receivables = list_records('receivables', 1, 100).get('items') or []
    payables = list_records('payables', 1, 100).get('items') or []
    pending = [row for row in orders if row.get('status') != '已完成']
    unpaid_receivables = [
        row for row in receivables
        if _number(row.get('amount')) > _number(row.get('received'))
    ]
    unpaid_payables = [
        row for row in payables
        if _number(row.get('amount')) > _number(row.get('paid'))
    ]
    lines = ['【三青系統提醒】', f'時間：{time.strftime("%Y-%m-%d %H:%M:%S")}', '']
    lines.append(f'未完成工單：{len(pending)} 筆')
    for row in pending[:5]:
        lines.append(f'- {row.get("orderDate") or "-"} / {row.get("billingCustomer") or row.get("upstream") or "-"} / {row.get("status") or "未完成"}')
    lines.append('')
    lines.append(f'應收未收：{len(unpaid_receivables)} 筆')
    for row in unpaid_receivables[:5]:
        remain = _number(row.get('amount')) - _number(row.get('received'))
        lines.append(f'- {row.get("customer") or "-"} / {row.get("orderNumber") or "-"} / 未收 NT$ {int(remain):,}')
    lines.append('')
    lines.append(f'應付未付：{len(unpaid_payables)} 筆')
    for row in unpaid_payables[:5]:
        remain = _number(row.get('amount')) - _number(row.get('paid'))
        lines.append(f'- {row.get("vendor") or "-"} / {row.get("item") or "-"} / 未付 NT$ {int(remain):,}')
    if len(lines) <= 7:
        lines.append('目前沒有明顯待處理事項。')
    return '\n'.join(lines)


def _safe_counts():
    entities = ['orders', 'customers', 'receivables', 'payables', LINE_DESTINATION_ENTITY]
    counts = {}
    for entity in entities:
        try:
            counts[entity] = int(list_records(entity, 1, 1).get('total') or 0)
        except Exception:
            counts[entity] = 0
    return counts


def _number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def _trim_text(text):
    return str(text or '').strip()[:4900] or '目前沒有內容。'


def _mask_destination(value):
    text = str(value or '')
    return f'{text[:6]}...{text[-4:]}' if len(text) > 12 else text
