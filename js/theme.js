const THEME_STORAGE_KEY = 'sanqingAppearance';
const THEME_OPTIONS = new Set(['system', 'light', 'dark']);
let initialized = false;

export function initializeTheme() {
  if (initialized) return;
  const shell = document.querySelector('main.app-shell');
  if (!shell) return;
  initialized = true;

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (THEME_OPTIONS.has(saved)) preference = saved;
  } catch { /* The system preference still works when storage is unavailable. */ }

  const bar = document.createElement('div');
  bar.className = 'theme-toolbar';
  const label = document.createElement('label');
  label.className = 'theme-control';
  const caption = document.createElement('span');
  caption.textContent = '外觀';
  const select = document.createElement('select');
  select.id = 'appearanceMode';
  select.setAttribute('aria-label', '網站外觀');
  for (const [value, text] of [['system', '跟隨裝置'], ['light', '淺色'], ['dark', '深色']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  label.append(caption, select);
  bar.append(label);
  shell.prepend(bar);

  const apply = () => {
    const mode = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.colorMode = mode;
    document.documentElement.style.colorScheme = mode;
    select.value = preference;
  };
  select.addEventListener('change', () => {
    preference = THEME_OPTIONS.has(select.value) ? select.value : 'system';
    try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* Keep the choice for this page. */ }
    apply();
  });
  const onSystemChange = () => { if (preference === 'system') apply(); };
  if (media?.addEventListener) media.addEventListener('change', onSystemChange);
  else media?.addListener?.(onSystemChange);
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = THEME_OPTIONS.has(event.newValue) ? event.newValue : 'system';
    apply();
  });
  apply();
}
