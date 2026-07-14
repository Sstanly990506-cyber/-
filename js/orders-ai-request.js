const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;
const MAX_NETWORK_FAILURES = 5;

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function networkErrorMessage(error) {
  const message = String(error?.message || error || '未知錯誤');
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(message)) {
    return '手機與伺服器的連線暫時中斷，請確認網路後再試。';
  }
  return message;
}

export async function requestOrderRecognition(state, image, onProgress = () => {}) {
  let started;
  try {
    started = await fetch('/api/orders/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.authToken || ''}` },
      body: JSON.stringify({ image, glossOptions: state.glossOptions, precision: true }),
    });
  } catch (error) {
    throw new Error(networkErrorMessage(error));
  }
  const job = await readResponse(started);
  if (job.order) return job.order;
  const recognitionId = String(job.recognitionId || '');
  if (!job.pending || !recognitionId) throw new Error('伺服器沒有建立 AI 辨識工作，請重新嘗試。');

  let networkFailures = 0;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    onProgress(`AI 正在辨識工單，已等待 ${attempt * 2} 秒…`);
    await wait(POLL_INTERVAL_MS);
    let response;
    try {
      response = await fetch(`/api/orders/recognize/status?id=${encodeURIComponent(recognitionId)}`, {
        headers: { Authorization: `Bearer ${state.authToken || ''}` },
        cache: 'no-store',
      });
    } catch (error) {
      networkFailures += 1;
      if (networkFailures >= MAX_NETWORK_FAILURES) throw new Error(`${networkErrorMessage(error)} AI 工作仍可稍後重新上傳。`);
      onProgress(`手機網路短暫中斷，正在重新連線（${networkFailures}/${MAX_NETWORK_FAILURES}）…`);
      continue;
    }
    const data = await readResponse(response);
    networkFailures = 0;
    if (data.pending) continue;
    if (data.order) return data.order;
    throw new Error('AI 已結束，但沒有可用的工單資料。');
  }
  throw new Error('AI 辨識超過 2 分鐘仍未完成，請稍後重新上傳。');
}
