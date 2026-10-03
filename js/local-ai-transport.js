export const SITE_ORIGIN = 'https://omega-ten-20.vercel.app';
export const SITE_ORIGINS = [SITE_ORIGIN, 'https://www.sanqingco.com', 'https://sanqingco.com'];
export const COMPANION_ORIGIN = 'http://127.0.0.1:4175';

// Fixed origins; scoped credentials and pairing only live in this closure.
export function createAiTransport({ siteRequest, fetchFn = fetch, origin = location.origin }) {
  let ticket = '';
  let capability = '';
  let generation = 0;
  const production = SITE_ORIGINS.includes(origin);
  const localDemo = /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);

  async function local(path, payload, signal, credentials = { ticket, capability }) {
    let response;
    try {
      response = await fetchFn(COMPANION_ORIGIN + path, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.ticket}`, ...(credentials.capability ? { 'X-Sanqing-Capability': credentials.capability } : {}) },
        body: JSON.stringify(payload), signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('連不到本機 AI。請啟動 start-companion.cmd，並允許正式網站的本機連線要求；不要關閉瀏覽器安全保護。');
    }
    const result = await response.json();
    if (!response.ok || !result.ok) {
      if (response.status === 401 && credentials.ticket === ticket && credentials.capability === capability) capability = '';
      throw new Error(result.error || '本機 AI 無法回應。');
    }
    return result;
  }

  return {
    production,
    connected: () => Boolean(capability),
    async begin(signal) {
      if (!production) throw new Error('請在正式網站進行配對。');
      const stamp = ++generation;
      capability = '';
      const result = await siteRequest('ticket', {}, signal);
      if (stamp !== generation) throw new Error('登入已變更。');
      ticket = result.ticket;
      return local('/pair', {}, signal);
    },
    async poll(pairId, signal) {
      const stamp = generation;
      const result = await local('/pair/status', { pairId }, signal);
      if (stamp !== generation) throw new Error('登入已變更。');
      if (result.status === 'connected') capability = result.capability;
      return result;
    },
    reset() {
      generation += 1;
      const previous = { ticket, capability };
      ticket = '';
      capability = '';
      if (production && previous.ticket && previous.capability) {
        local('/disconnect', {}, undefined, previous).catch(() => {});
      }
    },
    async request(path, payload, signal) {
      const stamp = generation;
      if (!production) {
        if (!localDemo) throw new Error('請使用正式網站或本機示範網址。');
        return siteRequest(path, payload, signal);
      }
      if (!capability) throw new Error('請先按「連接這台電腦」並完成本機確認。');
      if (path === 'chat' && ['general', 'documents'].includes(payload.mode)) {
        const { mode, question, history } = payload;
        return local('/chat', { mode, question, history }, signal);
      }
      if (['chat', 'preview', 'confirm'].includes(path)) {
        await local('/check', {}, signal);
        if (stamp !== generation) throw new Error('登入狀態已變更，操作已取消。');
        return siteRequest(path, payload, signal);
      }
      throw new Error('不支援的正式站操作。');
    },
  };
}
