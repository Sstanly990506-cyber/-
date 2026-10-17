// A stationary hold opens actions; moving or scrolling keeps normal list gestures.
export function bindOrderDeleteHold(body, findOrder, requestDelete, onOpen = () => {}) {
  if (!body) return;
  let hold = null;
  let suppressClickUntil = 0;
  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }
  function openActions(order) {
    onOpen();
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
  function startHold(event, point, kind) {
    cancelHold();
    if (event.target.closest('button, input, select, textarea, a')) return;
    const row = event.target.closest('tr[data-edit]');
    if (!row) return;
    const current = { row, pointerId: point.pointerId ?? point.identifier, kind, x: point.clientX, y: point.clientY, fired: false };
    hold = current;
    current.timer = setTimeout(() => {
      if (hold !== current || !row.isConnected || row.classList.contains('is-drag-placeholder')) return cancelHold();
      const order = findOrder(row.dataset.edit);
      if (!order) return cancelHold();
      current.fired = true;
      suppressClickUntil = Infinity;
      openActions(order);
    }, 3000);
  }
  // Mobile browsers may cancel pointer events for their built-in long press.
  // Track the touch lifecycle directly and ignore its duplicate pointer events.
  body.addEventListener('touchstart', event => {
    if (event.touches.length === 1) startHold(event, event.touches[0], 'touch');
    else cancelHold();
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (hold?.kind !== 'touch') return;
    if (event.touches.length !== 1) return cancelHold();
    const point = event.touches[0];
    if (!hold.fired && Math.hypot(point.clientX - hold.x, point.clientY - hold.y) > 18) cancelHold();
    else if (hold?.fired && event.cancelable) event.preventDefault();
  }, { passive: false });
  function endTouch(event) {
    if (hold?.kind !== 'touch') return;
    if (hold.fired) {
      suppressClickUntil = Date.now() + 700;
      if (event.cancelable) event.preventDefault();
    }
    cancelHold();
  }
  document.addEventListener('touchend', endTouch, { passive: false });
  document.addEventListener('touchcancel', endTouch, { passive: false });
  body.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') return;
    if (event.isPrimary === false || event.button !== 0) return cancelHold();
    startHold(event, event, 'pointer');
  });
  document.addEventListener('pointermove', event => {
    if (hold?.kind === 'pointer' && event.pointerId === hold.pointerId && !hold.fired
      && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancelHold();
  });
  function endHold(event) {
    if (hold?.kind !== 'pointer' || event.pointerId !== hold.pointerId) return;
    if (hold.fired) suppressClickUntil = Date.now() + 700;
    cancelHold();
  }
  document.addEventListener('pointerup', endHold);
  document.addEventListener('pointercancel', endHold);
  body.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const button = event.target.closest('button[data-order-menu]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const order = findOrder(button.dataset.orderMenu);
    if (order) openActions(order);
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
