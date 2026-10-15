export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; closed = false;
    } else {
      if (closed || char === '"') throw new Error('CSV 引號格式錯誤。');
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV 引號未閉合。');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim() !== ''));
}

export function parseInventoryCsv(text) {
  const rows = parseCsv(text);
  const expected = ['品項', '分類', '庫存', '單位', '安全庫存', '備註'];
  const header = rows.shift();
  if (!header || ![6, 7].includes(header.length) || expected.some((name, i) => header[i].trim() !== name)) {
    throw new Error('庫存 CSV 欄位不符，請使用網站匯出的檔案格式。');
  }
  const names = new Set();
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`第 ${index + 2} 列欄位數量錯誤。`);
    const [material, category, stock, unit, safetyStock, note] = row;
    const name = material.trim();
    if (!name || names.has(name)) throw new Error(`第 ${index + 2} 列品項為空白或重複。`);
    names.add(name);
    for (const value of [stock, safetyStock]) {
      if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`第 ${index + 2} 列庫存與安全庫存須為非負數字。`);
    }
    return { material: name, category: category.trim(), stock: Number(stock), unit: unit.trim() || 'kg', safetyStock: Number(safetyStock), note };
  });
}
