// A stationary hold opens actions; moving or scrolling keeps normal list gestures.
export function bindOrderDeleteHold(body, findOrder, requestDelete) {
  if (!body) return;
  let hold = null;
  let suppressClickUntil = 0;
  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }
  function openActions(order) {
    const dialog = document.createElement('dialog');
    dialog.className = 'order-actions-dialog';
    const title = document.createElement('h3');
    title.textContent = `工單 ${order.orderNumber || '未命名工單'}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn order-delete-action';
    remove.textContent = '刪除工單';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn ghost';
    cancel.textContent = '取消';
    cancel.autofocus = true;
    remove.addEventListener('click', () => {
      dialog.close();
      requestDelete(order.id);
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.append(title, remove, cancel);
    document.body.append(dialog);
    dialog.showModal();
  }
  body.addEventListener('pointerdown', event => {
    cancelHold();
    if (event.isPrimary === false || event.button !== 0) return;
    if (event.target.closest('button, input, select, textarea, a')) return;
    const row = event.target.closest('tr[data-edit]');
    if (!row) return;
    const current = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, fired: false };
    hold = current;
    current.timer = setTimeout(() => {
      if (hold !== current || !row.isConnected || row.classList.contains('is-drag-placeholder')) return cancelHold();
      const order = findOrder(row.dataset.edit);
      if (!order) return cancelHold();
      current.fired = true;
      suppressClickUntil = Infinity;
      openActions(order);
    }, 3000);
  });
  document.addEventListener('pointermove', event => {
    if (hold && event.pointerId === hold.pointerId && !hold.fired
      && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancelHold();
  });
  function endHold(event) {
    if (!hold || event.pointerId !== hold.pointerId) return;
    if (hold.fired) suppressClickUntil = Date.now() + 700;
    cancelHold();
  }
  document.addEventListener('pointerup', endHold);
  document.addEventListener('pointercancel', endHold);
  body.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  body.addEventListener('contextmenu', event => { if (hold) event.preventDefault(); });
  const reset = () => {
    if (hold?.fired) suppressClickUntil = Date.now() + 700;
    cancelHold();
  };
  document.addEventListener('scroll', reset, true);
  window.addEventListener('blur', reset);
  window.addEventListener('resize', reset);
}
