import { $, formatTs } from './shared.js';

export function renderNotifications(state) {
  const events = state.systemEvents || [];
  const warningCount = events.filter((event) => event.level === 'warning').length;
  const infoCount = events.filter((event) => event.level === 'info').length;
  const latest = events[0]?.at ? formatTs(new Date(events[0].at).getTime()) : '尚未同步';

  if ($('noticeTotalCount')) $('noticeTotalCount').textContent = String(events.length);
  if ($('noticeWarningCount')) $('noticeWarningCount').textContent = String(warningCount);
  if ($('noticeInfoCount')) $('noticeInfoCount').textContent = String(infoCount);
  if ($('noticeLatestAt')) $('noticeLatestAt').textContent = latest;

  if ($('notificationsList')) {
    $('notificationsList').innerHTML = events.length
      ? events.slice(0, 20).map((event) => `<li><strong>[${event.level || 'info'}]</strong> ${event.message || '-'}｜${event.user || '-'}｜${event.at || '-'}</li>`).join('')
      : '<li>目前沒有通知紀錄。</li>';
  }
}
