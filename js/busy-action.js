// Each instance protects one operation (or group of related operations).
// Set the latch before awaiting so even queued submit/click events cannot resend.
export function createBusyAction() {
  let pending = false;
  return async ({ button, controls = [], task }) => {
    if (pending) return;
    pending = true;
    const elements = [...new Set([button, ...controls].filter(Boolean))];
    const disabled = elements.map(element => element.disabled);
    const text = button?.textContent;
    const ariaBusy = button?.getAttribute('aria-busy');
    try {
      elements.forEach(element => { element.disabled = true; });
      if (button) {
        button.textContent = '處理中…';
        button.setAttribute('aria-busy', 'true');
      }
      return await task();
    } finally {
      elements.forEach((element, index) => { element.disabled = disabled[index]; });
      if (button) {
        button.textContent = text;
        if (ariaBusy == null) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', ariaBusy);
      }
      pending = false;
    }
  };
}
