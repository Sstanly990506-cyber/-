import { COMPANY_INFO, escapeHtml } from './shared.js';
import { toTaiInch } from './pricing.js';

function renderOrderTable(order) {
  const taiInch = toTaiInch(order.sizeLength, order.sizeUnit);
  const taiInchW = toTaiInch(order.sizeWidth, order.sizeUnit);
  const taiInchText = taiInch && taiInchW ? `天 ${taiInch.toFixed(2)} / 地 ${taiInchW.toFixed(2)} 台吋` : '-';
  return `
    <table>
      <tr><th>工單編號</th><td>${escapeHtml(order.orderNumber || '-')}</td><th>交貨日期</th><td>${escapeHtml(order.orderDate || '-')}</td></tr>
      <tr><th>客人</th><td colspan="3">${escapeHtml(order.billingCustomer || '-')}</td></tr>
      <tr><th>上游客戶</th><td>${escapeHtml(order.upstream || '-')}</td><th>下游客戶</th><td>${escapeHtml(order.downstream || '-')}</td></tr>
      <tr><th>地址</th><td colspan="3">${escapeHtml(order.address || '-')}</td></tr>
      <tr><th>數量說明</th><td>${escapeHtml(order.sheetCountText || order.sheetCount || '-')}</td><th>計算張數</th><td>${escapeHtml(order.sheetCount || '-')}</td></tr>
      <tr><th>天／地</th><td>${escapeHtml(taiInchText)}</td><th>上光種類</th><td>${escapeHtml(order.glossType || '-')}</td></tr>
    </table>
    <div class="footer"><span>客戶簽收：_____________</span><span>經手人：______________</span></div>`;
}

export function openOrderExportWindow(order) {
  if (!order.orderNumber) {
    alert('請先輸入工單編號，再列印工單。');
    return;
  }

  const html = `<!doctype html>
  <html lang="zh-Hant"><head><meta charset="UTF-8" />
  <title>工單列印</title>
  <style>
  body{font-family:"Noto Sans TC",sans-serif;padding:12px;color:#111}
  .copy{border:2px solid #555;padding:10px;margin-bottom:12px}
  h2{margin:0 0 8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #777;padding:6px;text-align:left}
  .footer{display:flex;justify-content:space-between;margin-top:12px}
  </style></head>
  <body>
    <div class="copy">
      <h2>${escapeHtml(COMPANY_INFO.name)} 工單</h2><p>${escapeHtml(COMPANY_INFO.address)}</p>
      ${renderOrderTable(order)}
    </div>
    <script>window.print();</script>
  </body></html>`;

  const win = window.open('', '_blank', 'width=900,height=760');
  if (!win) {
    alert('無法開啟列印視窗，請確認瀏覽器沒有封鎖彈出視窗。');
    return;
  }
  win.document.write(html);
  win.document.close();
}
