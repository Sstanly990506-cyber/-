export function bindOrderDrag(body, reorder, save, render) {
  if (!body) return;
  let drag = { active: false, after: false, orderId: '', pointerId: null, targetId: '', timer: null };
  const clear = () => {
    if (drag.timer) window.clearTimeout(drag.timer);
    body.querySelectorAll('.order-preview-row.is-dragging, .order-preview-row.is-drop-target')
      .forEach((row) => row.classList.remove('is-dragging', 'is-drop-target', 'drop-after'));
    drag = { active: false, after: false, orderId: '', pointerId: null, targetId: '', timer: null };
  };
  const updateTarget = (event) => {
    if (!drag.active) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('tr[data-edit]');
    if (!target || target.dataset.edit === drag.orderId) return;
    body.querySelectorAll('.order-preview-row.is-drop-target').forEach((row) => row.classList.remove('is-drop-target', 'drop-after'));
    const rect = target.getBoundingClientRect();
    drag.targetId = target.dataset.edit;
    drag.after = event.clientY > rect.top + rect.height / 2;
    target.classList.add('is-drop-target');
    target.classList.toggle('drop-after', drag.after);
  };
  body.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-order-drag-handle]');
    if (!handle || (event.pointerType === 'mouse' && event.button !== 0)) return;
    clear();
    drag.orderId = handle.dataset.orderDragHandle;
    drag.pointerId = event.pointerId;
    drag.timer = window.setTimeout(() => {
      drag.active = true;
      handle.closest('tr[data-edit]')?.classList.add('is-dragging');
      handle.setPointerCapture?.(event.pointerId);
    }, 350);
  });
  body.addEventListener('pointermove', updateTarget);
  body.addEventListener('pointerup', (event) => {
    if (!drag.active || event.pointerId !== drag.pointerId) return clear();
    const moved = reorder(drag.orderId, drag.targetId, drag.after);
    clear();
    if (moved) { save(); render(); }
  });
  body.addEventListener('pointercancel', clear);
}
