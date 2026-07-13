"""LINE Messaging API integration.

The webhook verifies LINE signatures, stores explicitly bound chat
destinations, and answers small read-only queries against the system records.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request

from api.records import list_records, upsert_record

LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply'
LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'
LINE_DESTINATION_ENTITY = 'lineDestinations'
DONE_STATUS = '已完成'
BOT_MENTION_ALIASES = ('三青實業有限公司', '三青系統', '三青', 'sanqing')


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
    reply_token = event.get('replyToken')
    event_type = event.get('type')

    if event_type in {'follow', 'join'} and reply_token:
        _reply(reply_token, '已連線到三青系統。輸入「綁定」後，就能接收通知並用 LINE 查詢工單、客戶、應收與庫存。')
        return
    if event_type != 'message' or (event.get('message') or {}).get('type') != 'text':
        return

    text = str((event.get('message') or {}).get('text') or '').strip()
    message = event.get('message') or {}
    if destination_type in {'group', 'room'}:
        if not _should_reply_in_shared_chat(text, message):
            return
        text = _strip_shared_chat_mention(text, message)
    response = _build_reply_text(text, destination_id, destination_type)
    if reply_token and response:
        _reply(reply_token, response, quick_reply=destination_type == 'user')


def _source_destination(source):
    if source.get('groupId'):
        return source.get('groupId'), 'group'
    if source.get('roomId'):
        return source.get('roomId'), 'room'
    if source.get('userId'):
        return source.get('userId'), 'user'
    return '', ''


def _save_destination(destination_id, destination_type, event=None):
    now = int(time.time() * 1000)
    upsert_record(LINE_DESTINATION_ENTITY, destination_id, {
        'id': destination_id,
        'destinationId': destination_id,
        'type': destination_type or 'user',
        'label': _mask_destination(destination_id),
        'active': True,
        'lastEventType': (event or {}).get('type') or '',
        'lastSeenAt': now,
        'createdAt': now,
    })


def _active_destinations():
    rows = list_records(LINE_DESTINATION_ENTITY, 1, 100).get('items') or []
    return [row for row in rows if row.get('active') is not False and (row.get('destinationId') or row.get('id'))]


def _is_active_destination(destination_id):
    if not destination_id:
        return False
    return any((row.get('destinationId') or row.get('id')) == destination_id for row in _active_destinations())


def _reply(reply_token, text, quick_reply=True):
    _line_api_post(LINE_REPLY_URL, {
        'replyToken': reply_token,
        'messages': [_line_text_message(text, quick_reply)],
    })


def _line_text_message(text, quick_reply=True):
    message = {'type': 'text', 'text': _trim_text(text)}
    if quick_reply:
        message['quickReply'] = {'items': _quick_reply_items()}
    return message


def _quick_reply_items():
    labels = [
        ('未完成工單', '未完成工單'),
        ('查工單', '工單'),
        ('查客戶', '客戶'),
        ('查應收', '應收'),
        ('查庫存', '庫存'),
        ('狀態', '狀態'),
        ('提醒', '提醒'),
        ('說明', '說明'),
    ]
    return [
        {
            'type': 'action',
            'action': {'type': 'message', 'label': label, 'text': message},
        }
        for label, message in labels
    ]


def _build_reply_text(text, destination_id='', destination_type='user'):
    text = _strip_bot_prefix(text)
    normalized = _normalize_command(text)
    if normalized in {'綁定', 'bind', '加入通知'}:
        _save_destination(destination_id, destination_type, {'type': 'message'})
        label = _mask_destination(destination_id)
        return f'已綁定此 LINE {destination_type or "user"}：{label}\n之後系統可主動推送提醒到這裡，也可以直接問我資料。'

    if not _is_active_destination(destination_id):
        return '請先輸入「綁定」，確認這個 LINE 聊天室可以查詢三青系統資料。'

    if normalized in {'狀態', 'status', '系統狀態'}:
        return _build_status_summary()
    if normalized in {'提醒', '通知', '財經', 'line提醒'}:
        return _build_system_reminder()
    if normalized in {'說明', 'help', '幫助', '?'}:
        return _build_help_text()

    answer = _build_query_reply(text)
    return answer or _build_help_text()


def _build_query_reply(text):
    text = _strip_bot_prefix(text)
    normalized = _normalize_command(text)
    keyword = _extract_keyword(text)
    order_keyword = _extract_order_keyword(text)
    if _is_pending_order_question(normalized):
        return _reply_pending_orders(keyword)
    if _is_order_question(normalized, order_keyword):
        return _reply_orders(order_keyword or keyword)
    if _is_customer_question(normalized):
        return _reply_customers(keyword)
    if _is_receivable_question(normalized):
        return _reply_receivables(keyword)
    if _is_payable_question(normalized):
        return _reply_payables(keyword)
    if _is_inventory_question(normalized):
        return _reply_inventory(keyword)
    if order_keyword:
        return _reply_orders(order_keyword)
    if keyword:
        return _reply_smart_summary(keyword)
    return ''


def _reply_orders(keyword=''):
    rows = _search_records('orders', keyword, 5)
    if not rows:
        return f'查不到工單：{keyword or "未提供關鍵字"}'
    lines = ['【工單查詢】']
    for row in rows:
        lines.append(_format_order(row))
    return '\n'.join(lines)


def _reply_pending_orders(keyword=''):
    rows = _search_records('orders', keyword, 100)
    pending = [row for row in rows if str(row.get('status') or '').strip() != DONE_STATUS]
    if not pending:
        return '目前查不到未完成工單。'
    lines = [f'【未完成工單】共 {len(pending)} 筆，先列前 8 筆']
    for row in pending[:8]:
        lines.append(_format_order(row))
    return '\n'.join(lines)


def _reply_customers(keyword=''):
    rows = _search_records('customers', keyword, 6)
    if not rows:
        return f'查不到客戶/廠商：{keyword or "未提供關鍵字"}'
    lines = ['【客戶/廠商查詢】']
    for row in rows:
        fields = [
            str(row.get('name') or '-'),
            f'角色：{row.get("role") or "-"}',
            f'統編：{row.get("taxId") or "-"}',
            f'電話：{row.get("phone") or "-"}',
            f'地址：{row.get("address") or "-"}',
        ]
        lines.append(' / '.join(fields))
    return '\n'.join(lines)


def _reply_receivables(keyword=''):
    rows = _search_records('receivables', keyword, 100)
    unpaid = [row for row in rows if _number(row.get('amount')) > _number(row.get('received'))]
    if not unpaid:
        return f'查不到應收未收資料：{keyword or "全部"}'
    total = sum(_number(row.get('amount')) - _number(row.get('received')) for row in unpaid)
    lines = [f'【應收未收】共 {len(unpaid)} 筆，合計 NT$ {int(total):,}']
    for row in unpaid[:8]:
        remain = _number(row.get('amount')) - _number(row.get('received'))
        lines.append(f'- {row.get("customer") or "-"} / {row.get("orderNumber") or "-"} / 未收 NT$ {int(remain):,}')
    return '\n'.join(lines)


def _reply_payables(keyword=''):
    rows = _search_records('payables', keyword, 100)
    unpaid = [row for row in rows if _number(row.get('amount')) > _number(row.get('paid'))]
    if not unpaid:
        return f'查不到應付未付資料：{keyword or "全部"}'
    total = sum(_number(row.get('amount')) - _number(row.get('paid')) for row in unpaid)
    lines = [f'【應付未付】共 {len(unpaid)} 筆，合計 NT$ {int(total):,}']
    for row in unpaid[:8]:
        remain = _number(row.get('amount')) - _number(row.get('paid'))
        lines.append(f'- {row.get("vendor") or "-"} / {row.get("item") or "-"} / 未付 NT$ {int(remain):,}')
    return '\n'.join(lines)


def _reply_inventory(keyword=''):
    rows = _search_records('inventory', keyword, 8)
    if not rows:
        return f'查不到庫存：{keyword or "未提供關鍵字"}'
    lines = ['【庫存查詢】']
    for row in rows:
        stock = row.get('stock') if row.get('stock') not in {None, ''} else '-'
        safety = row.get('safetyStock') if row.get('safetyStock') not in {None, ''} else '-'
        lines.append(f'- {row.get("material") or row.get("name") or "-"} / {row.get("category") or "-"} / 庫存 {stock}{row.get("unit") or ""} / 安全量 {safety}')
    return '\n'.join(lines)


def _reply_smart_summary(keyword):
    orders = _search_records('orders', keyword, 5)
    customers = _search_records('customers', keyword, 3)
    receivables = [
        row for row in _search_records('receivables', keyword, 100)
        if _number(row.get('amount')) > _number(row.get('received'))
    ]
    payables = [
        row for row in _search_records('payables', keyword, 100)
        if _number(row.get('amount')) > _number(row.get('paid'))
    ]
    inventory = _search_records('inventory', keyword, 3)
    if not any((orders, customers, receivables, payables, inventory)):
        return _build_not_found_hint(keyword)

    lines = [f'【智能查詢：{keyword}】']
    if customers:
        lines.append('客戶/廠商：')
        for row in customers[:3]:
            phone = row.get('phone') or '-'
            address = row.get('address') or '-'
            lines.append(f'- {row.get("name") or "-"} / {row.get("role") or "-"} / {phone} / {address}')
    if orders:
        lines.append('工單：')
        for row in orders[:5]:
            lines.append(_format_order(row))
    if receivables:
        total = sum(_number(row.get('amount')) - _number(row.get('received')) for row in receivables)
        lines.append(f'應收未收：{len(receivables)} 筆 / NT$ {int(total):,}')
        for row in receivables[:3]:
            remain = _number(row.get('amount')) - _number(row.get('received'))
            lines.append(f'- {row.get("customer") or "-"} / {row.get("orderNumber") or "-"} / NT$ {int(remain):,}')
    if payables:
        total = sum(_number(row.get('amount')) - _number(row.get('paid')) for row in payables)
        lines.append(f'應付未付：{len(payables)} 筆 / NT$ {int(total):,}')
    if inventory:
        lines.append('庫存：' + '、'.join(str(row.get('material') or row.get('name') or '-') for row in inventory))
    lines.append('想縮小範圍可以問：工單、客戶、應收、應付、庫存。')
    return '\n'.join(lines)


def _reply_global_search(keyword):
    sections = []
    orders = _search_records('orders', keyword, 3)
    customers = _search_records('customers', keyword, 3)
    receivables = _search_records('receivables', keyword, 3)
    if orders:
        sections.append('工單：' + '、'.join(str(row.get('orderNumber') or '-') for row in orders))
    if customers:
        sections.append('客戶：' + '、'.join(str(row.get('name') or '-') for row in customers))
    if receivables:
        sections.append('應收：' + '、'.join(str(row.get('orderNumber') or row.get('customer') or '-') for row in receivables))
    if not sections:
        return f'查不到「{keyword}」。你可以試：工單 {keyword}、客戶 {keyword}、應收 {keyword}'
    return '【綜合查詢】\n' + '\n'.join(sections)


def _format_order(row):
    customer = row.get('billingCustomer') or row.get('upstream') or row.get('downstream') or '-'
    date = row.get('orderDate') or row.get('deliveryDate') or '-'
    price = _number(row.get('totalPrice'))
    price_text = f' / NT$ {int(price):,}' if price else ''
    return f'- {row.get("orderNumber") or "-"} / {date} / {customer} / {row.get("status") or "未完成"}{price_text}'


def _search_records(entity, keyword='', limit=5):
    keyword = str(keyword or '').strip()
    try:
        query = keyword if keyword else ''
        page_size = 100 if keyword else min(max(limit, 1), 100)
        rows = list_records(entity, 1, page_size, query).get('items') or []
    except Exception:
        return []
    if keyword:
        rows = [row for row in rows if _matches_record(row, keyword)]
    return rows[:limit]


def _matches_record(row, keyword):
    haystack = json.dumps(row or {}, ensure_ascii=False).lower()
    compact_haystack = re.sub(r'\s+', '', haystack)
    compact_keyword = re.sub(r'\s+', '', str(keyword or '').lower())
    return compact_keyword in compact_haystack


def _extract_keyword(text):
    value = _strip_bot_prefix(text)
    value = re.sub(r'^(請問|麻煩|幫我|幫忙|可以|可不可以|能不能|查詢|查|找|搜尋|幫我查)\s*', '', value)
    value = re.sub(r'^(工單|客戶|客人|廠商|應收|未收|收款|應付|未付|付款|庫存|材料)\s*', '', value)
    value = re.sub(r'\s*(資料|狀態|多少|有哪些|幾筆|電話|地址|統編|欠多少|好了嗎|完成了嗎|做完了嗎|收了嗎|付了嗎|嗎|呢|啊|呀|喔|一下|\\?|？)\s*$', '', value)
    return value.strip()


def _normalize_command(text):
    return re.sub(r'\s+', '', str(text or '').strip()).lower()


def _extract_order_keyword(text):
    value = _strip_bot_prefix(text)
    match = re.search(r'(?<![A-Za-z0-9])([A-Za-z]{1,6}[- ]?\d{2,}|\d{5,})(?![A-Za-z0-9])', value)
    if match:
        return match.group(1).replace(' ', '')
    return ''


def _has_any(normalized, words):
    return any(word in normalized for word in words)


def _is_pending_order_question(normalized):
    return _has_any(normalized, (
        '未完成工單', '待處理工單', '未結工單', '還沒好', '沒做完',
        '待辦工單', '今天要做什麼', '今天做什麼', '要做什麼', '待辦',
    ))


def _is_order_question(normalized, order_keyword=''):
    return bool(order_keyword) or _has_any(normalized, (
        '工單', '訂單', '編號', '好了嗎', '完成了嗎', '做完了嗎',
        '交貨', '交期', '哪一天', '哪天',
    ))


def _is_customer_question(normalized):
    return _has_any(normalized, (
        '客戶', '客人', '廠商', '電話', '地址', '統編', '聯絡',
        '上游', '下游', '公司資料',
    ))


def _is_receivable_question(normalized):
    return _has_any(normalized, (
        '應收', '未收', '收款', '欠多少', '欠款', '還沒收',
        '收了嗎', '有沒有收', '對帳',
    ))


def _is_payable_question(normalized):
    return _has_any(normalized, (
        '應付', '未付', '付款', '還沒付', '付了嗎', '有沒有付',
    ))


def _is_inventory_question(normalized):
    return _has_any(normalized, ('庫存', '材料', '紙', '油', '膠', '剩多少'))


def _build_not_found_hint(keyword):
    return (
        f'查不到「{keyword}」。\n'
        '你可以這樣問：\n'
        f'- 工單 {keyword}\n'
        f'- 客戶 {keyword}\n'
        f'- 應收 {keyword}\n'
        '或直接按下面的查詢按鈕。'
    )


def _strip_bot_prefix(text):
    value = str(text or '').strip()
    value = _remove_invisible_chars(value)
    value = re.sub(rf'^@?\s*({_bot_alias_pattern()})\s*[,，:：]?\s*', '', value, flags=re.IGNORECASE)
    return value.strip()


def _strip_bot_mention(text):
    value = str(text or '').strip()
    value = _remove_invisible_chars(value)
    return re.sub(rf'^@\s*({_bot_alias_pattern()})\s*[,，:：]?\s*', '', value, flags=re.IGNORECASE).strip()


def _bot_alias_pattern():
    return '|'.join(re.escape(alias) for alias in BOT_MENTION_ALIASES)


def _remove_invisible_chars(text):
    return re.sub(r'[\ufeff\u200b\u200c\u200d]', '', str(text or ''))


def _find_bot_mention(text, message):
    bot_user_id = os.environ.get('LINE_BOT_USER_ID', '').strip()
    mention = (message or {}).get('mention') or {}
    for item in mention.get('mentionees') or []:
        if item.get('isSelf') is True:
            return item
        if bot_user_id and str(item.get('userId') or '') == bot_user_id:
            return item
        segment = _mention_segment(text, item)
        if segment and re.search(rf'^@\s*({_bot_alias_pattern()})\s*$', _remove_invisible_chars(segment).strip(), re.IGNORECASE):
            return item
    return None


def _mention_segment(text, mentionee):
    try:
        index = int(mentionee.get('index'))
        length = int(mentionee.get('length'))
    except (TypeError, ValueError):
        return ''
    if index < 0 or length <= 0:
        return ''
    return str(text or '')[index:index + length]


def _strip_shared_chat_mention(text, message=None):
    value = str(text or '').strip()
    stripped = _strip_bot_mention(value)
    if stripped != _remove_invisible_chars(value).strip():
        return stripped
    mentionee = _find_bot_mention(value, message)
    if not mentionee:
        return value
    segment = _mention_segment(value, mentionee)
    if not segment:
        return value
    return value.replace(segment, '', 1).strip(' \t\r\n,，:：')


def _should_reply_in_shared_chat(text, message=None):
    value = str(text or '').strip()
    mentioned_text = _strip_shared_chat_mention(value, message)
    if mentioned_text != _remove_invisible_chars(value).strip():
        return bool(mentioned_text)
    return False


def _build_help_text():
    return (
        '可以這樣問我：\n'
        '- 工單 115060162\n'
        '- 未完成工單\n'
        '- 客戶 三青\n'
        '- 應收 佳德\n'
        '- 應付 油墨\n'
        '- 庫存 紙\n'
        '- 狀態\n'
        '- 提醒\n'
        '群組裡只有 @三青 才會回，例如：@三青 客戶 佳德。'
    )


def _build_status_summary():
    counts = _safe_counts()
    return (
        '【三青系統狀態】\n'
        f'工單：{counts["orders"]} 筆\n'
        f'客戶：{counts["customers"]} 筆\n'
        f'應收：{counts["receivables"]} 筆\n'
        f'應付：{counts["payables"]} 筆\n'
        f'LINE 綁定：{counts["lineDestinations"]} 個'
    )


def _build_system_reminder():
    orders = list_records('orders', 1, 100).get('items') or []
    receivables = list_records('receivables', 1, 100).get('items') or []
    payables = list_records('payables', 1, 100).get('items') or []
    pending = [row for row in orders if row.get('status') != DONE_STATUS]
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
        lines.append(_format_order(row))
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
    return str(text or '').strip()[:4900] or '目前沒有可回覆的內容。'


def _mask_destination(value):
    text = str(value or '')
    return f'{text[:6]}...{text[-4:]}' if len(text) > 12 else text
