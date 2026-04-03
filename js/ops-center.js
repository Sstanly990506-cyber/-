import { $, money } from './shared.js';

function olderThan(dateText, days) {
  if (!dateText) return false;
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return false;
  return (Date.now() - date.getTime()) / 86400000 >= days;
}

export function renderOpsCenter(state) {
  const warningDays = Number(state.settings?.orderWarningDays || 3);
  const pendingOrders = state.orders.filter((o) => !['已完成', '已取消'].includes(o.status || '未完成'));
  const delayedOrders = pendingOrders.filter((order) => olderThan(order.orderDate, warningDays));
  const missingDataOrders = pendingOrders.filter((order) => !order.address || Number(order.totalPrice || 0) <= 0);
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = state.orders.filter((o) => (o.updatedAt || '').includes(today) && (o.status || '') === '已完成');
  const waitingRevenue = pendingOrders.reduce((sum, order) => sum + Number(order.totalPrice || 0), 0);

  if ($('opsPendingCount')) $('opsPendingCount').textContent = String(pendingOrders.length);
  if ($('opsDelayedCount')) $('opsDelayedCount').textContent = String(delayedOrders.length);
  if ($('opsMissingDataCount')) $('opsMissingDataCount').textContent = String(missingDataOrders.length);
  if ($('opsDoneTodayCount')) $('opsDoneTodayCount').textContent = String(doneToday.length);
  if ($('opsWaitingRevenue')) $('opsWaitingRevenue').textContent = `NT$ ${money(waitingRevenue)}`;

  if ($('opsDelayedList')) {
    $('opsDelayedList').innerHTML = delayedOrders.length
      ? delayedOrders.slice(0, 8).map((order) => `<li><button class="btn ops-link-btn" data-open-order="${order.id}">${order.orderNumber || '-'}｜${order.downstream || order.upstream || '-'}｜${order.orderDate || '-'}｜${order.status || '未完成'}</button></li>`).join('')
      : '<li>目前沒有逾期待處理工單。</li>';
  }

  if ($('opsMissingDataList')) {
    $('opsMissingDataList').innerHTML = missingDataOrders.length
      ? missingDataOrders.slice(0, 8).map((order) => `<li><button class="btn ops-link-btn" data-open-order="${order.id}">${order.orderNumber || '-'}｜缺少${!order.address ? '地址' : ''}${!order.address && Number(order.totalPrice || 0) <= 0 ? '、' : ''}${Number(order.totalPrice || 0) <= 0 ? '總價' : ''}</button></li>`).join('')
      : '<li>目前沒有資料不完整的工單。</li>';
  }
}

export function bindOpsCenterEvents() {
  ['opsDelayedList', 'opsMissingDataList'].forEach((id) => {
    $(id)?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-open-order]');
      if (!btn) return;
      window.dispatchEvent(new CustomEvent('app:open-order-detail', { detail: { orderId: btn.dataset.openOrder } }));
    });
  });
}
