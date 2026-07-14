import { $ } from './shared.js';

export const AI_RECOGNITION_FIELDS = {
  orderNumber: { input: 'orderNumber', label: '工單編號' },
  orderDate: { input: 'orderDate', label: '交貨日期' },
  billingCustomer: { input: 'billingCustomerInput', label: '客人' },
  upstream: { input: 'upstreamInput', label: '上游客戶' },
  downstream: { input: 'downstreamInput', label: '下游客戶' },
  address: { input: 'orderAddress', label: '送貨地址' },
  sheetCountText: { input: 'sheetCountText', label: '數量說明' },
  sheetCount: { input: 'sheetCount', label: '計算張數' },
  sizeLength: { input: 'sizeLength', label: '天' },
  sizeWidth: { input: 'sizeWidth', label: '地' },
  sizeUnit: { input: 'sizeUnit', label: '單位' },
  glossType: { input: 'glossType', label: '上光種類' },
};

export function clearAiRecognitionReview() {
  const container = $('aiRecognitionReview');
  if (!container) return;
  container.replaceChildren();
  container.classList.add('hidden');
}

export function renderAiRecognitionReview(order = {}) {
  const container = $('aiRecognitionReview');
  if (!container) return;
  const confidence = order.fieldConfidence && typeof order.fieldConfidence === 'object' ? order.fieldConfidence : {};
  const requested = Array.isArray(order.reviewFields) ? order.reviewFields : [];
  const reviewFields = [...new Set(requested.filter((field) => AI_RECOGNITION_FIELDS[field]))];
  const candidates = order.customerCandidates && typeof order.customerCandidates === 'object' ? order.customerCandidates : {};
  if (!reviewFields.length && !Object.keys(candidates).length) {
    clearAiRecognitionReview();
    return;
  }
  container.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = '請確認以下欄位，系統沒有直接替你猜。';
  container.append(title);
  reviewFields.forEach((field) => {
    const meta = AI_RECOGNITION_FIELDS[field];
    const row = document.createElement('div');
    row.className = 'ai-review-item';
    const detail = document.createElement('span');
    const percentage = Math.round(Number(confidence[field] || 0) * 100);
    detail.textContent = `${meta.label}${percentage ? `（辨識信心 ${percentage}%）` : ''}`;
    row.append(detail);
    (Array.isArray(candidates[field]) ? candidates[field] : []).forEach((name) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary';
      button.dataset.aiCandidateField = field;
      button.dataset.aiCandidateValue = String(name);
      button.textContent = `改用：${name}`;
      row.append(button);
    });
    container.append(row);
  });
  container.classList.remove('hidden');
}

export async function prepareOrderImage(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('請選擇 JPEG、PNG 或 WebP 圖片。');
  if (file.size > 12 * 1024 * 1024) throw new Error('原始圖片不可超過 12 MB。');
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取圖片。'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error('圖片格式無法解析。'));
    value.src = source;
  });
  let maxDimension = 1600;
  let quality = 0.82;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = (pixels.data[index] * 0.299) + (pixels.data[index + 1] * 0.587) + (pixels.data[index + 2] * 0.114);
      const contrast = Math.max(0, Math.min(255, ((gray - 128) * 1.35) + 128));
      pixels.data[index] = contrast;
      pixels.data[index + 1] = contrast;
      pixels.data[index + 2] = contrast;
    }
    context.putImageData(pixels, 0, 0);
    const encoded = canvas.toDataURL('image/jpeg', quality);
    if (encoded.length <= 1_800_000) return encoded;
    maxDimension = Math.round(maxDimension * 0.82);
    quality = Math.max(0.6, quality - 0.06);
  }
  throw new Error('圖片壓縮後仍過大，請裁切圖片或改拍較清晰的工單。');
}
