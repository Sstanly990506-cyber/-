import { $, formatTs, downloadCsv, escapeHtml } from './shared.js';

const LINE_OFFICIAL_ACCOUNT_ID = '@971smwet';
const LINE_OFFICIAL_ACCOUNT_LINK = `https://line.me/R/ti/p/${LINE_OFFICIAL_ACCOUNT_ID}`;

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
  const latest = events[0]?.at ? formatTs(new Date(events[0].at).getTime()) : '撌脣摮?;

  if ($('noticeTotalCount')) $('noticeTotalCount').textContent = String(events.length);
  if ($('noticeWarningCount')) $('noticeWarningCount').textContent = String(warningCount);
  if ($('noticeInfoCount')) $('noticeInfoCount').textContent = String(infoCount);
  if ($('noticeLatestAt')) $('noticeLatestAt').textContent = latest;

  if ($('notificationsList')) {
    $('notificationsList').innerHTML = filtered.length
      ? filtered.slice(0, 40).map((event) => `<li class="${event.readAt ? 'notice-read' : 'notice-unread'}"><strong>[${escapeHtml(event.level || 'info')}]</strong> ${escapeHtml(event.message || '-')}｜${escapeHtml(event.user || '-')}｜${escapeHtml(event.at || '-')}${event.readAt ? `｜已讀 ${escapeHtml(event.readAt)}` : ''}</li>`).join('')
      : '<li>?桀?瘝??蝝??/li>';
  }

  if ($('lineWebhookUrl')) $('lineWebhookUrl').value = `${location.origin}/api/line/webhook`;
  if ($('lineOfficialAccountLink')) $('lineOfficialAccountLink').href = LINE_OFFICIAL_ACCOUNT_LINK;
}

async function refreshLineStatus(state) {
  if (!$('lineConfiguredStatus')) return;
  $('lineConfiguredStatus').textContent = '瑼Ｘ銝?..';
  try {
    const response = await fetch('/api/line/status', {
      headers: { Authorization: `Bearer ${state.authToken || ''}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    $('lineConfiguredStatus').textContent = data.configured ? '撌脰身摰? : '?芾身摰?;
    if ($('lineDestinationCount')) $('lineDestinationCount').textContent = String(data.destinationCount || 0);
    if ($('lineStatusDetail')) {
      if (!data.configured) {
        $('lineStatusDetail').textContent = '撠閮剖? LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN嚗?? Vercel ?啣?霈閮剖???;
      } else if (!data.destinationCount) {
        $('lineStatusDetail').textContent = `LINE 撌脰身摰???雿??芰?摰?憭拙恕???銝?摰撣唾? ${LINE_OFFICIAL_ACCOUNT_ID}嚗閰脰?憭拙恕頛詨??摰?閬??LINE 蝟餌絞?撣唾??;
      } else {
        $('lineStatusDetail').textContent = `Webhook URL嚗?{location.origin}/api/line/webhook?歇蝬? ${data.destinationCount} ??憭拙恕嚗?葫閰阡?;
      }
    }
  } catch (err) {
    $('lineConfiguredStatus').textContent = '瑼Ｘ憭望?';
    if ($('lineStatusDetail')) $('lineStatusDetail').textContent = `LINE ??炎?亙仃??${err.message}`;
  }
}

async function sendLineTest(state) {
  const message = `???頂蝯望葫閰阡?n??嚗?{new Date().toLocaleString()}\n憒?雿??圈?閮嚗誨銵?LINE ?冽撌脤???;
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
    const rows = [['??', '蝑?', '閮', '雿輻??, '撌脰???']];
    getFilteredEvents(state).forEach((event) => rows.push([event.at || '', event.level || 'info', event.message || '', event.user || '', event.readAt || '']));
    downloadCsv('notifications-log.csv', rows);
  });

  $('refreshLineStatusBtn')?.addEventListener('click', () => refreshLineStatus(state));
  $('sendLineTestBtn')?.addEventListener('click', async () => {
    try {
      const result = await sendLineTest(state);
      alert(`LINE 皜祈岫?撌脤嚗?{result.sent || 0} ??憭拙恕?);
      await refreshLineStatus(state);
    } catch (err) {
      alert(`LINE 皜祈岫?憭望?嚗?{err.message}`);
      await refreshLineStatus(state);
    }
  });
  refreshLineStatus(state);
}
