let nonce = '';
let stopped = false;
let signature = '';
const status = document.getElementById('status');
const pending = document.getElementById('pending');

async function control(action, payload = {}) {
  const response = await fetch('/control/' + action, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Sanqing-Control': nonce },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '無法完成操作。');
}

async function refresh() {
  if (stopped) return;
  try {
    const response = await fetch('/control', { cache: 'no-store', credentials: 'omit', headers: { 'X-Sanqing-Control': '1' } });
    if (!response.ok) throw new Error('本機控制頁無法讀取。');
    const data = await response.json();
    nonce = data.nonce;
    document.getElementById('connected').textContent = data.connected ? '目前已有網站連接本機 AI。' : '目前沒有網站連接。';
    const nextSignature = JSON.stringify(data.pending);
    if (nextSignature !== signature) {
      signature = nextSignature;
      pending.replaceChildren();
      if (!data.pending.length) pending.textContent = '目前沒有待確認請求。請先在正式網站按「連接這台電腦」。';
      for (const request of data.pending) {
        const block = document.createElement('section');
        const user = document.createElement('p');
        user.textContent = `${request.display}（${request.username}）`;
        const code = document.createElement('p');
        code.className = 'code';
        code.textContent = request.code;
        const approve = document.createElement('button');
        approve.className = 'approve';
        approve.textContent = '編號一致，同意這次配對';
        approve.addEventListener('click', async () => {
          approve.disabled = true;
          try { await control('approve', { pairId: request.id }); status.textContent = '已同意，請回正式網站使用 AI。'; await refresh(); }
          catch (err) { status.textContent = err.message; approve.disabled = false; }
        });
        block.append(user, code, approve);
        pending.append(block);
      }
    }
  } catch (err) { status.textContent = err.message || '本機 AI 已停止。'; }
}
document.getElementById('revoke').addEventListener('click', async () => {
  try { await control('revoke'); status.textContent = '已中斷配對。'; await refresh(); }
  catch (err) { status.textContent = err.message; }
});
document.getElementById('stop').addEventListener('click', async () => {
  if (!window.confirm('確定停止本機 AI？不會刪除任何資料。')) return;
  try { await control('stop'); stopped = true; status.textContent = '本機 AI 正在停止，資料不會刪除。'; }
  catch (err) { status.textContent = err.message; }
});
refresh();
setInterval(refresh, 2000);
