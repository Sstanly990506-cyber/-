import { $, formatTs, downloadCsv } from './shared.js';

function getFilteredEvents(state) {
  const events = state.systemEvents || [];
  const type = $('noticeTypeFilter')?.value || 'all';
  const from = $('noticeDateFrom')?.value || '';
  const to = $('noticeDateTo')?.value || '';
  const keyword = ($('noticeKeyword')?.value || '').trim().toLowerCase();
  return events.filter((event) => {
    if (type !== 'all' && event.level !== type) return false;
    const dateText = String(event.at || '').slice(0, 10);
    if (from && dateText && dateText < from) return false;
    if (to && dateText && dateText > to) return false;
    if (!keyword) return true;
    return [event.message, event.user, event.level].join(' ').toLowerCase().includes(keyword);
  });
}

export function renderNotifications(state) {
  const events = state.systemEvents || [];
  const filtered = getFilteredEvents(state);
  const warningCount = events.filter((event) => event.level === 'warning').length;
  const infoCount = events.filter((event) => event.level === 'info').length;
  const latest = events[0]?.at ? formatTs(new Date(events[0].at).getTime()) : '已儲存';

  if ($('noticeTotalCount')) $('noticeTotalCount').textContent = String(events.length);
  if ($('noticeWarningCount')) $('noticeWarningCount').textContent = String(warningCount);
  if ($('noticeInfoCount')) $('noticeInfoCount').textContent = String(infoCount);
  if ($('noticeLatestAt')) $('noticeLatestAt').textContent = latest;

  if ($('notificationsList')) {
    $('notificationsList').innerHTML = filtered.length
      ? filtered.slice(0, 40).map((event) => `<li class="${event.readAt ? 'notice-read' : 'notice-unread'}"><strong>[${event.level || 'info'}]</strong> ${event.message || '-'}｜${event.user || '-'}｜${event.at || '-'}${event.readAt ? `｜已讀 ${event.readAt}` : ''}</li>`).join('')
      : '<li>目前沒有通知紀錄。</li>';
  }

  if ($('lineWebhookUrl')) $('lineWebhookUrl').value = `${location.origin}/api/line/webhook`;
}

async function refreshLineStatus(state) {
  if (!$('lineConfiguredStatus')) return;
  $('lineConfiguredStatus').textContent = '檢查中...';
  try {
    const response = await fetch('/api/line/status', {
      headers: { Authorization: `Bearer ${state.authToken || ''}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('lineConfiguredStatus').textContent = data.configured ? '已設定' : '未設定';
    if ($('lineDestinationCount')) $('lineDestinationCount').textContent = String(data.destinationCount || 0);
    if ($('lineStatusDetail')) {
      $('lineStatusDetail').textContent = data.configured
        ? `Webhook URL：${location.origin}/api/line/webhook。LINE 中輸入「綁定」後即可接收推播。`
        : '尚未設定 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN，請先到 Vercel 環境變數設定。';
    }
  } catch (err) {
    $('lineConfiguredStatus').textContent = '檢查失敗';
    if ($('lineStatusDetail')) $('lineStatusDetail').textContent = `LINE 狀態檢查失敗：${err.message}`;
  }
}

async function sendLineTest(state) {
  const message = `【三青系統測試通知】\n時間：${new Date().toLocaleString()}\n如果你看到這則訊息，代表 LINE 推播已連線。`;
  const response = await fetch('/api/line/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
    body: JSON.stringify({ message }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function bindNotificationEvents(state, saveState, renderAll) {
  ['noticeTypeFilter', 'noticeDateFrom', 'noticeDateTo', 'noticeKeyword'].forEach((id) => {
    $(id)?.addEventListener('input', () => renderNotifications(state));
    $(id)?.addEventListener('change', () => renderNotifications(state));
  });

  $('markNoticeReadBtn')?.addEventListener('click', () => {
    const now = new Date().toLocaleString();
    getFilteredEvents(state).forEach((event) => {
      if (!event.readAt) event.readAt = now;
    });
    saveState();
    renderAll();
  });

  $('exportNoticeBtn')?.addEventListener('click', () => {
    const rows = [['時間', '等級', '訊息', '使用者', '已讀時間']];
    getFilteredEvents(state).forEach((event) => rows.push([event.at || '', event.level || 'info', event.message || '', event.user || '', event.readAt || '']));
    downloadCsv('notifications-log.csv', rows);
  });

  $('refreshLineStatusBtn')?.addEventListener('click', () => refreshLineStatus(state));
  $('sendLineTestBtn')?.addEventListener('click', async () => {
    try {
      const result = await sendLineTest(state);
      alert(`LINE 測試通知已送出：${result.sent || 0} 個聊天室。`);
      await refreshLineStatus(state);
    } catch (err) {
      alert(`LINE 測試通知失敗：${err.message}`);
      await refreshLineStatus(state);
    }
  });
  refreshLineStatus(state);
}
