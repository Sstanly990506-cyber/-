const CATEGORY_TITLES = {
  company: '公司與外觀',
  modules: '功能模組',
  accounts: '帳號與權限',
  maintenance: '系統維護與備份',
};

// Keep every form field mounted: settings.js reads the complete draft, even
// while another category is visible.
export function bindSettingsNavigation() {
  const root = document.getElementById('settingsView');
  const home = document.getElementById('settingsCategoryHome');
  const heading = document.getElementById('settingsCategoryHeading');
  const title = document.getElementById('settingsCategoryTitle');
  const form = document.getElementById('settingsForm');
  if (!root || !home || !heading || !title || !form) return;
  let active = null;

  function showCategory(next, focus = true) {
    if (next !== null && !CATEGORY_TITLES[next]) return;
    if (active && active !== next) {
      const canLeave = form.dispatchEvent(new CustomEvent('settings:leave-category', {
        bubbles: true, cancelable: true, detail: { from: active, to: next },
      }));
      if (!canLeave) return;
    }
    active = next;
    home.hidden = Boolean(next);
    heading.hidden = !next;
    if (next) title.textContent = CATEGORY_TITLES[next];
    root.querySelectorAll('[data-settings-section]').forEach(section => {
      const categories = (section.dataset.settingsSection || '').split(/\s+/);
      section.hidden = !next || !categories.includes(next);
    });
    if (focus && next) title.focus({ preventScroll: true });
  }

  root.addEventListener('click', event => {
    const opener = event.target.closest('[data-settings-category-open]');
    if (opener) return showCategory(opener.dataset.settingsCategoryOpen);
    if (event.target.closest('#settingsCategoryBack')) return showCategory(null);
    if (event.target.closest('[data-back]') && active) {
      // Capture before app navigation hides this view.
      const canLeave = form.dispatchEvent(new CustomEvent('settings:leave-category', {
        bubbles: true, cancelable: true, detail: { from: active, to: null },
      }));
      if (!canLeave) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }, true);
  document.getElementById('settingsBtn')?.addEventListener('click', () => showCategory(null, false));
  showCategory(null, false);
}
