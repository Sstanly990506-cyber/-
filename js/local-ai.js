import { state } from './store.js?v=20261003-system-audit-1';
import { createAiTransport, COMPANION_ORIGIN } from './local-ai-transport.js?v=20261003-system-audit-1';

const node = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
};

// All assistant / document / record text is rendered as text, never HTML.
export function initializeLocalAi({ onDemoLogin, onDataChanged }) {
  const root = node('aside', 'sq-ai hidden');
  const toggle = node('button', 'sq-ai-toggle', '三青 AI 助理');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'sq-ai-panel');
  const panel = node('section', 'sq-ai-panel hidden');
  panel.id = 'sq-ai-panel';
  panel.setAttribute('aria-label', '三青 AI 助理');
  const head = node('header', 'sq-ai-head');
  const brand = node('div');
  brand.append(node('strong', '', '三青 AI 助理'), node('p', 'sq-ai-sub', '只在這台電腦運作 · 不使用雲端 AI'));
  const close = node('button', 'btn', '關閉');
  close.type = 'button';
  head.append(brand, close);
  const tools = node('div', 'sq-ai-tools');
  const mode = node('select');
  mode.setAttribute('aria-label', '助理模式');
  for (const [value, text] of [['general', '一般聊天'], ['documents', '文件查詢'], ['data', '網站資料']]) {
    const option = node('option', '', text);
    option.value = value;
    mode.append(option);
  }
  const entity = node('select', 'hidden');
  entity.setAttribute('aria-label', '資料種類');
  for (const [value, text] of [['orders', '工單'], ['customers', '客戶'], ['inventory', '庫存']]) {
    const option = node('option', '', text);
    option.value = value;
    entity.append(option);
  }
  const clear = node('button', 'btn', '清除對話');
  clear.type = 'button';
  tools.append(mode, entity, clear);
  const hint = node('p', 'sq-ai-hint');
  const messages = node('div', 'sq-ai-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  const status = node('p', 'sq-ai-status');
  status.setAttribute('role', 'status');
  const form = node('form', 'sq-ai-compose');
  const input = node('textarea');
  input.rows = 2;
  input.maxLength = 1200;
  input.required = true;
  input.setAttribute('aria-label', '你的問題');
  const send = node('button', 'btn primary', '送出');
  send.type = 'submit';
  form.append(input, send);
  panel.append(head, tools, hint, messages, status, form);
  root.append(toggle, panel);
  document.body.append(root);
  let history = [];
  let epoch = 0;
  let busy = false;
  let currentToken = null;
  const requests = new Set();
  const transport = createAiTransport({ siteRequest });
  const pairing = node('div', 'sq-ai-pairing');
  const connect = node('button', 'btn primary', '連接這台電腦');
  connect.type = 'button';
  const controlLink = node('a', 'btn', '開啟本機配對頁');
  controlLink.href = COMPANION_ORIGIN;
  controlLink.target = '_blank';
  controlLink.rel = 'noopener noreferrer';
  const pairStatus = node('p', '', '先啟動 start-companion.cmd，再連接；第一版限管理員。');
  pairStatus.setAttribute('role', 'status');
  pairing.append(connect, controlLink, pairStatus);
  if (transport.production) panel.insertBefore(pairing, tools);

  connect.addEventListener('click', async () => {
    const controller = new AbortController();
    requests.add(controller);
    connect.disabled = true;
    const stamp = epoch;
    const timeout = window.setTimeout(() => controller.abort(), 120000);
    try {
      const pair = await transport.begin(controller.signal);
      pairStatus.textContent = `配對編號：${pair.code}。請開啟本機配對頁，核對帳號和編號並同意。`;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (stamp !== epoch || controller.signal.aborted) return;
        const result = await transport.poll(pair.pairId, controller.signal);
        if (result.status === 'connected') {
          pairStatus.textContent = '已連接這台電腦，現在可以提問。授權最長 20 分鐘。';
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 2000));
      }
      pairStatus.textContent = '配對逾期，請重新連接。';
    } catch (err) {
      if (stamp === epoch) pairStatus.textContent = err.name === 'AbortError' ? '配對逾期，請重新連接。' : err.message;
    } finally {
      window.clearTimeout(timeout);
      requests.delete(controller);
      connect.disabled = false;
    }
  });

  function updateMode() {
    entity.classList.toggle('hidden', mode.value !== 'data');
    hint.textContent = mode.value === 'data'
      ? '輸入工單編號、客戶名稱、品項，或「最近」。只顯示有權限的前 5 筆；不做完整統計。'
      : mode.value === 'documents'
        ? '只依據已匯入文件回答並列出來源。文件庫目前只開放管理員。'
        : '可聊天、整理文字與解釋程式。公司資訊請切換文件或網站資料；請勿貼上密碼與金鑰。';
    input.placeholder = mode.value === 'data' ? '例如：DEMO-001、透明膜、最近' : '例如：你好，能幫我做什麼？';
    input.maxLength = mode.value === 'data' ? 100 : 1200;
  }
  updateMode();
  mode.addEventListener('change', updateMode);
  function show(open) {
    panel.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    (open ? input : toggle).focus();
  }
  toggle.addEventListener('click', () => show(panel.classList.contains('hidden')));
  close.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') show(false);
  });
  function reset() {
    epoch += 1;
    for (const controller of requests) controller.abort();
    requests.clear();
    history = [];
    messages.replaceChildren();
    status.textContent = '';
    busy = false;
    send.disabled = false;
    input.value = '';
  }
  clear.addEventListener('click', reset);
  window.addEventListener('app:auth-changed', () => queueMicrotask(() => {
    if (state.authToken !== currentToken) { reset(); transport.reset(); pairStatus.textContent = '請連接這台電腦並確認配對。'; }
    currentToken = state.authToken;
    root.classList.toggle('hidden', !currentToken || (transport.production && state.userRole !== 'admin'));
    mode.querySelector('[value="documents"]').disabled = state.userRole !== 'admin';
    if (state.userRole !== 'admin' && mode.value === 'documents') mode.value = 'general';
    if (!currentToken) show(false);
    updateMode();
  }));

  async function siteRequest(path, payload, signal) {
    const token = state.authToken;
    const response = await fetch('/api/local-ai/' + path, {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload), signal,
    });
    if (state.authToken !== token) throw new Error('登入狀態已變更。');
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || '目前無法回應。');
    return data;
  }

  async function request(path, payload) {
    const controller = new AbortController();
    const stamp = epoch;
    const token = state.authToken;
    requests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 180000);
    try {
      const data = await transport.request(path, payload, controller.signal);
      if (epoch !== stamp || state.authToken !== token) throw new Error('登入狀態已變更。');
      return data;
    } finally {
      requests.delete(controller);
      window.clearTimeout(timeout);
    }
  }
  function message(text, user = false) {
    const box = node('article', 'sq-ai-message' + (user ? ' sq-ai-user' : ''));
    box.append(node('small', '', user ? '你' : '三青 AI'), node('p', '', text));
    messages.append(box);
    while (messages.children.length > 30) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
    return box;
  }
  function noteEditor(box, row) {
    const edit = node('button', 'btn', `修改「${row.material}」備註`);
    edit.type = 'button';
    box.append(edit);
    edit.addEventListener('click', () => {
      edit.disabled = true;
      const editor = node('form', 'sq-ai-edit');
      editor.append(node('p', '', '只修改這一筆備註，不會改庫存數量。'));
      const note = node('textarea');
      note.setAttribute('aria-label', '新的庫存備註');
      note.maxLength = 500;
      note.required = true;
      note.value = row.note;
      const preview = node('button', 'btn', '先看修改預覽');
      preview.type = 'submit';
      editor.append(note, preview);
      box.append(editor);
      editor.addEventListener('submit', async (event) => {
        event.preventDefault();
        const stamp = epoch;
        preview.disabled = true;
        try {
          const proposal = await request('preview', { recordId: row.id, note: note.value });
          note.disabled = true;
          const warning = node('div', 'sq-ai-warning');
          warning.append(node('p', '', proposal.warning), node('p', '', `原備註：${proposal.before || '空白'}\n新備註：${proposal.after}\n120 秒內有效；取消不會修改資料。`));
          const confirm = node('button', 'btn primary', '確認修改這筆備註');
          confirm.type = 'button';
          const cancel = node('button', 'btn', '取消');
          cancel.type = 'button';
          warning.append(confirm, cancel);
          box.append(warning);
          const expiry = window.setTimeout(() => { confirm.disabled = true; confirm.textContent = '預覽已逾期，請重新查詢'; }, 120000);
          cancel.addEventListener('click', () => { window.clearTimeout(expiry); warning.remove(); editor.remove(); edit.disabled = false; });
          confirm.addEventListener('click', async () => {
            window.clearTimeout(expiry);
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              const result = await request('confirm', { proposalId: proposal.proposalId, confirmed: true });
              message(result.answer + '\n稽核編號：' + result.auditId);
              confirm.textContent = '已完成';
              Promise.resolve(onDataChanged()).catch(() => { status.textContent = '已儲存；畫面同步失敗，請重新整理。'; });
            } catch (err) {
              if (stamp === epoch) message(err.name === 'AbortError' ? '儲存結果未知，請重新查詢；不要重複提交。' : err.message);
            }
          });
        } catch (err) {
          if (stamp === epoch) { message(err.message); preview.disabled = false; }
        }
      });
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !input.value.trim()) return;
    const question = input.value.trim();
    const chosenMode = mode.value;
    const stamp = epoch;
    busy = true;
    send.disabled = true;
    input.value = '';
    // Do not echo user input until accepted: it may contain a pasted secret.
    status.textContent = chosenMode === 'data' ? '正在查詢網站資料…' : '正在本機處理；第一次載入模型可能較久…';
    try {
      const data = await request('chat', { question, mode: chosenMode, entity: entity.value, history: chosenMode === 'general' ? history : [] });
      message(question, true);
      const box = message(data.answer);
      if (data.sources?.length) {
        const list = node('ul', 'sq-ai-sources');
        for (const source of data.sources) list.append(node('li', '', source));
        box.append(node('strong', '', '資料來源'), list);
      }
      if (chosenMode === 'data' && data.canEditNote) for (const row of data.rows) noteEditor(box, row);
      // Company documents and website rows are never included in general chat history.
      if (chosenMode === 'general' && data.mode === 'general' && data.found) history = [...history, [question.slice(0, 300), data.answer.slice(0, 500)]].slice(-2);
      status.textContent = '';
    } catch (err) {
      if (stamp === epoch) status.textContent = err.name === 'AbortError' ? '等待逾時。模型可能仍在釋放記憶體，請稍後再試。' : err.message;
    } finally {
      if (stamp === epoch) { busy = false; send.disabled = false; input.focus(); }
    }
  });

  // Added only by the isolated runner; ordinary website logins remain unchanged.
  fetch('/api/local-ai/config', { cache: 'no-store' }).then(r => r.json()).then(config => {
    if (!config.demo) return;
    const login = document.getElementById('loginView');
    const stop = node('button', 'btn', '停止本機示範');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      if (!window.confirm('確定停止這個本機示範網站？不會刪除資料。')) return;
      stop.disabled = true;
      try { message((await request('stop', { confirmed: true })).answer); }
      catch (err) { status.textContent = err.message; stop.disabled = false; }
    });
    tools.append(stop);
    const notice = node('p', 'sq-ai-demo', '本機假資料示範：不是正式網站，沒有連線正式資料庫。');
    const demo = node('button', 'btn primary', '進入假資料示範（不需密碼）');
    demo.type = 'button';
    demo.addEventListener('click', async () => {
      demo.disabled = true;
      try { await onDemoLogin(await request('demo-session', {})); }
      catch (err) { notice.textContent = err.message; }
      finally { demo.disabled = false; }
    });
    login.append(notice, demo);
  }).catch(() => {});
}
