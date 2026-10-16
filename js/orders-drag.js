// The original row reserves the drop position; a separate preview follows the hand.
export function createOrderDragPreview(body, row, startPoint, onReorder, onCancel) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const origin = row.getBoundingClientRect();
  const floating = document.createElement('div');
  floating.className = 'order-drag-preview';
  floating.setAttribute('aria-hidden', 'true');
  Object.assign(floating.style, {
    left: `${origin.left}px`, top: `${origin.top}px`, width: `${origin.width}px`,
  });
  const table = document.createElement('table');
  table.className = 'orders-table';
  const rows = document.createElement('tbody');
  const clone = row.cloneNode(true);
  clone.classList.remove('is-just-completed');
  clone.classList.add('is-dragging');
  rows.append(clone);
  table.append(rows);
  floating.append(table);
  document.body.append(floating);
  row.classList.add('is-drag-placeholder');
  document.documentElement.classList.add('is-order-dragging');

  let point = { ...startPoint };
  let frame;
  let stopped = false;
  const animations = new Map();
  const wrap = body.closest('.orders-table-wrap');
  const scrollsInside = wrap && /auto|scroll/.test(getComputedStyle(wrap).overflowY)
    && wrap.scrollHeight > wrap.clientHeight;

  function scrollNearEdge() {
    const bounds = scrollsInside ? wrap.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const edge = 56;
    const distance = point.clientY < bounds.top + edge
      ? point.clientY - bounds.top - edge
      : point.clientY > bounds.bottom - edge ? point.clientY - bounds.bottom + edge : 0;
    const speed = Math.max(-16, Math.min(16, distance * 0.25));
    if (speed) {
      if (scrollsInside) wrap.scrollTop += speed;
      else window.scrollBy({ top: speed, behavior: 'instant' });
    }
  }

  function placePlaceholder() {
    const target = document.elementFromPoint(point.clientX, point.clientY)?.closest('tr[data-edit]');
    if (!target || target === row || target.parentElement !== body) return;
    const rect = target.getBoundingClientRect();
    const after = point.clientY > rect.top + rect.height / 2;
    const reference = after ? target.nextSibling : target;
    if (reference === row || row.nextSibling === reference) return;

    const siblings = [...body.children].filter(item => item !== row);
    const before = new Map(siblings.map(item => [item, item.getBoundingClientRect().top]));
    animations.forEach(animation => animation.cancel());
    animations.clear();
    body.insertBefore(row, reference);
    if (!reducedMotion) {
      for (const item of siblings) {
        const offset = before.get(item) - item.getBoundingClientRect().top;
        if (Math.abs(offset) < 1) continue;
        animations.set(item, item.animate([
          { transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' },
        ], { duration: 180, easing: 'ease-out' }));
      }
    }
    onReorder(target.dataset.edit, after);
  }

  function tick() {
    if (stopped) return;
    if (!row.isConnected) { onCancel(); return; }
    floating.style.transform = `translate3d(${point.clientX - startPoint.clientX}px, ${point.clientY - startPoint.clientY}px, 0)`;
    scrollNearEdge();
    placePlaceholder();
    frame = requestAnimationFrame(tick);
  }
  // Force the initial size to paint before shrinking the lifted card.
  table.getBoundingClientRect();
  floating.classList.add('is-lifted');
  frame = requestAnimationFrame(tick);

  function cleanup(done) {
    animations.forEach(animation => animation.cancel());
    floating.remove();
    row.classList.remove('is-drag-placeholder');
    document.documentElement.classList.remove('is-order-dragging');
    done();
  }
  function stop() { stopped = true; cancelAnimationFrame(frame); }
  return {
    move(nextPoint) { point = { ...nextPoint }; },
    flush() { placePlaceholder(); },
    drop(done) {
      stop();
      const target = row.getBoundingClientRect();
      floating.classList.add('is-dropping');
      floating.classList.remove('is-lifted');
      floating.style.transform = `translate3d(${target.left - origin.left}px, ${target.top - origin.top}px, 0)`;
      if (reducedMotion) cleanup(done);
      else setTimeout(() => cleanup(done), 180);
    },
    cancel(done) { stop(); cleanup(done); },
  };
}
