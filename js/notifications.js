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
  const latest = events[0]?.at ? formatTs(new Date(events[0].at).getTime()) : '尚無資料';

  if ($('noticeTotalCount')) $('noticeTotalCount').textContent = String(events.length);
  if ($('noticeWarningCount')) $('noticeWarningCount').textContent = String(warningCount);
  if ($('noticeInfoCount')) $('noticeInfoCount').textContent = String(infoCount);
  if ($('noticeLatestAt')) $('noticeLatestAt').textContent = latest;

  if ($('notificationsList')) {
    $('notificationsList').innerHTML = filtered.length
      ? filtered.slice(0, 40).map((event) => `<li class="${event.readAt ? 'notice-read' : 'notice-unread'}"><strong>[${escapeHtml(event.level || 'info')}]</strong> ${escapeHtml(event.message || '-')}｜${escapeHtml(event.user || '-')}｜${escapeHtml(event.at || '-')}${event.readAt ? `｜已讀 ${escapeHtml(event.readAt)}` : ''}</li>`).join('')
      : '<li>目前沒有通知事件。</li>';
  }

  if ($('lineWebhookUrl')) $('lineWebhookUrl').value = `${location.origin}/api/line/webhook`;
  if ($('lineOfficialAccountLink')) $('lineOfficialAccountLink').href = LINE_OFFICIAL_ACCOUNT_LINK;
}

function customerOptions(state, selected) {
  const names = [...new Set((state.customers || []).map((row) => String(row.name || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (selected && !names.includes(selected)) names.unshift(selected);
  return ['<option value="">請選擇客戶</option>', ...names.map((name) => `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`)].join('');
}

function renderLineDestinationSettings(state, destinations) {
  const root = $('lineDestinationSettings');
  if (!root) return;
  if (!destinations.length) {
    root.innerHTML = '<p class="sub">目前沒有已綁定聊天室。</p>';
    return;
  }
  const canEdit = state.userRole === 'admin';
  root.innerHTML = destinations.map((destination) => {
    const mode = destination.accessMode === 'internal' ? 'internal' : 'customer';
    const customer = String(destination.customerName || '');
    const disabled = canEdit ? '' : ' disabled';
    return `<div class="card line-destination-row" data-line-destination="${escapeHtml(destination.id || '')}">
      <div><strong>${escapeHtml(destination.label || 'LINE 聊天室')}</strong><span class="sub">${escapeHtml(destination.type || 'user')}</span></div>
      <label>權限模式<select data-line-mode${disabled}>
        <option value="customer"${mode === 'customer' ? ' selected' : ''}>客戶查詢</option>
        <option value="internal"${mode === 'internal' ? ' selected' : ''}>內部完整查詢</option>
      </select></label>
      <label>指定客戶<select data-line-customer${mode === 'internal' ? ' disabled' : ''}${disabled}>${customerOptions(state, customer)}</select></label>
      ${canEdit ? '<button class="btn primary" type="button" data-save-line-destination>儲存權限</button>' : '<span class="sub">僅管理員可修改</span>'}
    </div>`;
  }).join('');

  root.querySelectorAll('[data-line-mode]').forEach((select) => {
    select.addEventListener('change', () => {
      const row = select.closest('[data-line-destination]');
      const customer = row?.querySelector('[data-line-customer]');
      if (customer) customer.disabled = select.value === 'internal';
    });
  });
  root.querySelectorAll('[data-save-line-destination]').forEach((button) => {
    button.addEventListener('click', async () => {
      const row = button.closest('[data-line-destination]');
      const accessMode = row?.querySelector('[data-line-mode]')?.value || 'customer';
      const customerName = row?.querySelector('[data-line-customer]')?.value || '';
      if (accessMode === 'customer' && !customerName) return alert('客戶查詢模式必須指定一家公司。');
      button.disabled = true;
      try {
        const response = await fetch('/api/line/destinations/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
          body: JSON.stringify({ id: row?.dataset.lineDestination || '', accessMode, customerName }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        await refreshLineStatus(state);
      } catch (err) {
        alert(`LINE 權限儲存失敗：${err.message}`);
      } finally {
        button.disabled = false;
      }
    });
  });
}

export async function refreshLineStatus(state) {
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
    renderLineDestinationSettings(state, data.destinations || []);
    if ($('lineStatusDetail')) {
      if (!data.configured) {
        $('lineStatusDetail').textContent = '尚未設定 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN，請到 Vercel 環境變數設定。';
      } else if (!data.destinationCount) {
        $('lineStatusDetail').textContent = `LINE 已設定，但尚未綁定接收者。請在 LINE 傳「綁定」給官方帳號 ${LINE_OFFICIAL_ACCOUNT_ID}。`;
      } else {
        $('lineStatusDetail').textContent = `Webhook URL：${location.origin}/api/line/webhook。已綁定 ${data.destinationCount} 個接收者。`;
      }
    }
  } catch (err) {
    const status = $('lineConfiguredStatus');
    if (status) status.textContent = '檢查失敗';
    if ($('lineStatusDetail')) $('lineStatusDetail').textContent = `LINE 狀態檢查失敗：${err.message}`;
  }
}

async function sendLineTest(state) {
  const message = `三青系統 LINE 測試通知\n時間：${new Date().toLocaleString()}\n如果你收到這則訊息，代表 LINE 通知已可正常發送。`;
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
      alert(`LINE 測試通知已送出：${result.sent || 0} 個對象。`);
      await refreshLineStatus(state);
    } catch (err) {
      alert(`LINE 測試通知失敗：${err.message}`);
      await refreshLineStatus(state);
    }
  });
}
