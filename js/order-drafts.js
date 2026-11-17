// Draft contents are encrypted with an account-specific key held only in memory.
// Drafts are never sent as orders without an explicit user action.
export function createOrderDraftVault(state) {
  const form = document.getElementById('orderForm');
  if (!form) return null;
  const prefix = 'sanqing-order-draft-v1:';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const metadata = ['expectedVersion', 'saveBlocked', 'pendingPayload', 'pendingVersion'];
  let active = null, authEpoch = 0, owner = null, key = null, ownerPrefix = null;
  let authPromise = Promise.resolve(false), renderSequence = 0;
  const slots = new Map();
  const panel = document.createElement('div');
  panel.className = 'order-field-wide';
  panel.setAttribute('aria-label', '工單草稿');
  const status = document.createElement('p');
  status.className = 'sub'; status.setAttribute('role', 'status');
  const select = document.createElement('select');
  select.setAttribute('aria-label', '選擇工單草稿');
  const restoreButton = document.createElement('button');
  restoreButton.type = 'button'; restoreButton.className = 'btn'; restoreButton.textContent = '恢復草稿';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button'; deleteButton.className = 'btn'; deleteButton.textContent = '刪除草稿';
  panel.append(status, select, restoreButton, deleteButton);
  form.prepend(panel);
  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  const token = () => ({ id: String(state.accountId || ''), token: state.authToken || '' });
  const isCurrent = (id, epoch) => epoch === authEpoch && String(state.accountId || '') === id;
  const newId = () => {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    if (!globalThis.crypto?.getRandomValues) return null;
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  };

  function snapshot() {
    const fields = {};
    for (const el of form.elements) {
      if (!el.id || ['file', 'password', 'submit', 'button', 'reset'].includes(el.type)) continue;
      fields[el.id] = ['checkbox', 'radio'].includes(el.type) ? { checked: el.checked } : { value: el.value };
    }
    const data = {};
    for (const name of metadata) if (form.dataset[name] !== undefined) data[name] = form.dataset[name];
    return { fields, data, updatedAt: new Date().toISOString() };
  }
  function mark() {
    if (!state.accountId || !state.authToken) return;
    if (!active) {
      const id = newId();
      if (!id) { status.textContent = '此裝置暫時無法保護草稿，請勿關閉正在編輯的畫面。'; return; }
      active = { id, ownerId: String(state.accountId), rev: 0, promise: Promise.resolve(), timer: null, deleted: false, source: null };
      slots.set(active.id, active);
    }
    const slot = active;
    slot.rev++; slot.snapshot = snapshot();
    status.textContent = '正在保護草稿，請稍候再關閉或登出。';
    // Begin encryption immediately; closing the browser can still interrupt it.
    persist(slot, slot.rev);
  }
  function revision() { return active ? { id: active.id, rev: active.rev } : null; }
  function detach() { active = null; }
  async function initialize() {
    const epoch = ++authEpoch;
    owner = null; key = null; ownerPrefix = null; active = null; slots.clear();
    const identity = token();
    if (!identity.id || !identity.token) { status.textContent = '登入後可使用本裝置的加密草稿。'; render(); return false; }
    status.textContent = '正在準備加密草稿…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch('/api/orders/draft-key', { headers: { Authorization: `Bearer ${identity.token}` }, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('key unavailable');
      const data = await response.json();
      if (String(data.ownerId) !== identity.id) throw new Error('wrong account');
      const cryptoKey = await crypto.subtle.importKey('raw', unb64(data.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(identity.id));
      if (!isCurrent(identity.id, epoch)) return false;
      owner = identity.id; key = cryptoKey;
      ownerPrefix = prefix + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') + ':';
      status.textContent = '草稿會加密保存在這個裝置。請等待草稿出現在清單後再關閉或登出；恢復後請核對內容。';
      render(); return true;
    } catch {
      if (isCurrent(identity.id, epoch)) status.textContent = '此裝置暫時無法保護草稿，仍可正常儲存工單；請勿關閉正在編輯的畫面。';
      return false;
    } finally { clearTimeout(timeout); }
  }
  async function encrypt(slot, value, slotKey, slotOwner) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(slotOwner + ':' + slot.id) }, slotKey, encoder.encode(JSON.stringify(value)));
    return JSON.stringify({ version: 1, iv: b64(iv), data: b64(new Uint8Array(data)) });
  }
  async function decrypt(id, value, slotKey, slotOwner) {
    const object = JSON.parse(value);
    if (object.version !== 1) throw new Error('unsupported');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(object.iv), additionalData: encoder.encode(slotOwner + ':' + id) }, slotKey, unb64(object.data));
    return JSON.parse(decoder.decode(plain));
  }
  function persist(slot, rev) {
    clearTimeout(slot.timer);
    const value = slot.snapshot, epoch = authEpoch, accountId = String(state.accountId || '');
    // Capture an already authorized key so a pending encryption may finish
    // safely after logout, still encrypted under the original account.
    const captured = owner === accountId && key && ownerPrefix ? { key, owner, prefix: ownerPrefix } : null;
    const pendingAuth = authPromise;
    slot.promise = slot.promise.then(async () => {
      if (!captured && (!await pendingAuth || !isCurrent(accountId, epoch))) {
        if (isCurrent(accountId, epoch) && active === slot && slot.rev === rev) status.textContent = '此裝置暫時無法保護草稿，仍可正常儲存工單；請勿關閉正在編輯的畫面。';
        return false;
      }
      const credentials = captured || (owner === accountId && key && ownerPrefix ? { key, owner, prefix: ownerPrefix } : null);
      if (!credentials || slot.deleted || slot.rev !== rev) return false;
      const currentKey = credentials.key, currentOwner = credentials.owner, storageKey = credentials.prefix + slot.id;
      const ciphertext = await encrypt(slot, value, currentKey, currentOwner);
      if (slot.deleted || slot.rev !== rev) return false;
      localStorage.setItem(storageKey, ciphertext);
      if (isCurrent(accountId, epoch)) {
        if (active === slot) status.textContent = '草稿已加密保存在這個裝置。恢復後請核對內容。';
        render();
      }
      return true;
    }).catch(() => { status.textContent = '此裝置無法保存草稿，請勿關閉正在編輯的畫面。'; return false; });
    return slot.promise;
  }
  async function flush(rev = revision()) {
    const slot = rev && slots.get(rev.id);
    if (!slot || slot.rev !== rev.rev) return false;
    return persist(slot, rev.rev);
  }
  async function whenSettled(rev = revision()) {
    const slot = rev && slots.get(rev.id);
    if (!slot || slot.rev !== rev.rev) return false;
    const saved = await slot.promise;
    return !!saved && active === slot && slot.rev === rev.rev && !slot.deleted;
  }
  async function clearIfRevision(rev) {
    const slot = rev && slots.get(rev.id);
    if (!slot || slot.rev !== rev.rev) return false;
    await slot.promise;
    if (slot.rev !== rev.rev || !ownerPrefix || slot.ownerId !== String(state.accountId || '') || slots.get(slot.id) !== slot) return false;
    slot.deleted = true; clearTimeout(slot.timer);
    try {
      localStorage.removeItem(ownerPrefix + slot.id);
      if (slot.source && localStorage.getItem(slot.source.key) === slot.source.value) localStorage.removeItem(slot.source.key);
      slots.delete(slot.id); if (active === slot) active = null;
      render(); return true;
    } catch { status.textContent = '草稿清除失敗，請於草稿清單手動確認。'; return false; }
  }
  async function render() {
    const sequence = ++renderSequence, currentPrefix = ownerPrefix, currentKey = key, currentOwner = owner;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '選擇本裝置的草稿'; select.append(placeholder);
    if (!currentPrefix || !currentKey) return;
    try {
      const records = [];
      for (let i = 0; i < localStorage.length; i++) {
        const storageKey = localStorage.key(i);
        if (!storageKey?.startsWith(currentPrefix)) continue;
        const value = localStorage.getItem(storageKey), id = storageKey.slice(currentPrefix.length);
        try {
          const data = await decrypt(id, value, currentKey, currentOwner);
          records.push({ id, value, data });
        } catch { records.push({ id, value, data: null }); }
      }
      if (sequence !== renderSequence || currentPrefix !== ownerPrefix) return;
      records.sort((a, b) => (b.data?.updatedAt || '').localeCompare(a.data?.updatedAt || ''));
      for (const record of records) {
        const option = document.createElement('option'); option.value = record.id;
        const number = record.data?.fields?.orderNumber?.value;
        option.textContent = record.data ? `${number || '未命名工單'} — ${record.data.updatedAt ? new Date(record.data.updatedAt).toLocaleString() : ''}${record.data.data?.saveBlocked === 'uncertain' ? '（儲存結果待核對）' : ''}` : '無法解密的草稿（請保留並聯繫管理員）';
        option.disabled = !record.data; select.append(option);
      }
    } catch { status.textContent = '此裝置無法讀取草稿，請檢查瀏覽器儲存空間。'; }
  }
  restoreButton.addEventListener('click', async () => {
    const id = select.value, currentPrefix = ownerPrefix, currentKey = key, currentOwner = owner, epoch = authEpoch;
    if (!id || !currentPrefix || !currentKey) return;
    try {
      const storageKey = currentPrefix + id, value = localStorage.getItem(storageKey);
      if (!value) return render();
      const data = await decrypt(id, value, currentKey, currentOwner);
      if (!isCurrent(currentOwner, epoch) || !data.fields || !data.data) return;
      if (!form.dispatchEvent(new CustomEvent('order:before-draft-restore', { bubbles: true, cancelable: true }))) return;
      detach();
      for (const [fieldId, field] of Object.entries(data.fields)) {
        const element = document.getElementById(fieldId);
        if (!element || !form.contains(element) || ['file', 'password', 'submit', 'button', 'reset'].includes(element.type)) continue;
        if ('checked' in field) element.checked = !!field.checked;
        else if ('value' in field) element.value = String(field.value);
      }
      for (const name of metadata) { delete form.dataset[name]; if (typeof data.data[name] === 'string') form.dataset[name] = data.data[name]; }
      mark(); if (active) active.source = { key: storageKey, value };
      form.dispatchEvent(new CustomEvent('order:draft-restored', { bubbles: true }));
      status.textContent = '已恢復草稿，請核對內容；不會自動送出工單。';
    } catch { status.textContent = '無法恢復此草稿，原始資料仍保留。'; }
  });
  deleteButton.addEventListener('click', () => {
    const id = select.value;
    if (!id || !ownerPrefix || !window.confirm('確定要刪除此裝置上的草稿嗎？')) return;
    try {
      const slot = slots.get(id);
      if (slot) { slot.deleted = true; clearTimeout(slot.timer); slots.delete(id); if (active === slot) active = null; }
      localStorage.removeItem(ownerPrefix + id); render();
    } catch { status.textContent = '草稿刪除失敗。'; }
  });
  form.addEventListener('input', event => { if (!panel.contains(event.target)) mark(); });
  form.addEventListener('change', event => { if (!panel.contains(event.target)) mark(); });
  form.addEventListener('order:draft-change', mark);
  window.addEventListener('app:auth-changed', () => {
    // Finance unlock can refresh the token without changing the account.
    if (owner && owner === String(state.accountId || '') && state.authToken) return;
    authPromise = initialize();
  });
  authPromise = initialize();
  return { mark, revision, flush, whenSettled, clearIfRevision, detach };
}
