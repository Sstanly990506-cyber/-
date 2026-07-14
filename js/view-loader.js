window.__appBootstrapped = false;

const APP_ASSET_VERSION = '20260714-login-guard-2';
const mount = document.getElementById('appMount');
const apiWarmup = fetch('/api/health', { cache: 'no-store' }).catch(() => null);

async function loadApplicationView() {
  const response = await fetch(`views/app-shell.html?v=${APP_ASSET_VERSION}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`無法載入畫面元件：HTTP ${response.status}`);

  const source = new DOMParser().parseFromString(await response.text(), 'text/html');
  const applicationMain = source.querySelector('main.app-shell');
  if (!applicationMain) throw new Error('畫面元件缺少 main.app-shell');

  mount.replaceWith(document.importNode(applicationMain, true));
  await import(`./main.js?v=${APP_ASSET_VERSION}`);
  apiWarmup.catch(() => null);
}

loadApplicationView().catch((error) => {
  console.error(error);
  mount.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'panel card';
  const title = document.createElement('h1');
  title.textContent = '系統畫面載入失敗';
  const detail = document.createElement('p');
  detail.className = 'sub';
  detail.textContent = error?.message || String(error);
  panel.append(title, detail);
  mount.append(panel);
});
