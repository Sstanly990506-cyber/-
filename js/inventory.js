import { $, money, downloadCsv, escapeHtml } from './shared.js';

import { parseInventoryCsv } from './csv.js?v=20261015-audit-fixes-1';

function buildItem(state) {
  return {
    id: $('inventoryItemId').value || crypto.randomUUID(),
    material: $('inventoryMaterial').value.trim(),
    category: $('inventoryCategory').value.trim(),
    stock: Number($('inventoryStock').value || 0),
    unit: $('inventoryUnit').value.trim() || 'kg',
    safetyStock: Number($('inventorySafetyStock').value || state.settings?.inventoryLowStockDefault || 100),
    note: $('inventoryNote').value.trim(),
    updatedAt: new Date().toLocaleString(),
  };
}

function clearInventoryForm() {
  $('inventoryForm')?.reset();
  if ($('inventoryItemId')) $('inventoryItemId').value = '';
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getVisibleInventoryItems(state) {
  const keyword = ($('inventorySearch')?.value || '').trim().toLowerCase();
  const sortBy = $('inventorySort')?.value || 'updatedAt-desc';
  const source = [...(state.inventoryItems || [])].filter((item) => {
    if (!keyword) return true;
    return [item.material, item.category, item.note].join(' ').toLowerCase().includes(keyword);
  });
  source.sort((a, b) => {
    if (sortBy === 'material-asc') return String(a.material || '').localeCompare(String(b.material || ''), 'zh-Hant');
    if (sortBy === 'stock-asc') return toSafeNumber(a.stock) - toSafeNumber(b.stock);
    if (sortBy === 'stock-desc') return toSafeNumber(b.stock) - toSafeNumber(a.stock);
    if (sortBy === 'safety-asc') {
      const riskA = toSafeNumber(a.stock) - toSafeNumber(a.safetyStock);
      const riskB = toSafeNumber(b.stock) - toSafeNumber(b.safetyStock);
      return riskA - riskB;
    }
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return source;
}

export function renderInventory(state) {
  const body = $('inventoryTbody');
  const items = state.inventoryItems || [];
  const visible = getVisibleInventoryItems(state);
  if ($('inventoryItemsCount')) $('inventoryItemsCount').textContent = String(items.length);
  if ($('inventoryLowCount')) $('inventoryLowCount').textContent = String(items.filter((item) => Number(item.stock || 0) <= Number(item.safetyStock || 0)).length);
  if ($('inventoryStockValue')) $('inventoryStockValue').textContent = `總量 ${money(items.reduce((sum, item) => sum + Number(item.stock || 0), 0))}`;
  if (!body) return;
  body.innerHTML = visible.map((item) => {
    const low = Number(item.stock || 0) <= Number(item.safetyStock || 0);
    const danger = Number(item.stock || 0) <= Number(item.safetyStock || 0) * 0.5;
    return `<tr>
      <td><span class="${danger ? 'stock-danger' : low ? 'stock-warning' : ''}">${escapeHtml(item.material || '-')}</span></td>
      <td>${escapeHtml(item.category || '-')}</td>
      <td>${money(item.stock)} ${escapeHtml(item.unit || '')}</td>
      <td>${money(item.safetyStock)} ${escapeHtml(item.unit || '')}</td>
      <td><span class="tag ${danger ? 'danger' : low ? 'warn' : ''}">${danger ? '危險' : low ? '偏低' : '正常'}</span></td>
      <td>${escapeHtml(item.note || '-')}</td>
      <td>${escapeHtml(item.updatedAt || '-')}</td>
      <td><button class="btn" data-edit-inventory="${escapeHtml(item.id)}">編輯</button></td>
    </tr>`;
  }).join('');
}

export function bindInventoryEvents(state, saveState, renderAll) {
  $('inventoryForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const item = buildItem(state);
    if (!item.material) return alert('請輸入材料名稱。');
    const idx = state.inventoryItems.findIndex((row) => row.id === item.id);
    if (idx >= 0) state.inventoryItems[idx] = item;
    else state.inventoryItems.unshift(item);
    saveState();
    clearInventoryForm();
    renderAll();
  });

  $('inventoryClearBtn')?.addEventListener('click', clearInventoryForm);
  $('inventorySearch')?.addEventListener('input', () => renderInventory(state));
  $('inventorySort')?.addEventListener('change', () => renderInventory(state));

  $('inventoryExportBtn')?.addEventListener('click', () => {
    const rows = [['品項', '分類', '庫存', '單位', '安全庫存', '備註', '更新時間']];
    getVisibleInventoryItems(state).forEach((item) => rows.push([item.material, item.category, item.stock, item.unit, item.safetyStock, item.note, item.updatedAt]));
    downloadCsv('inventory-items.csv', rows);
  });

  $('inventoryImportFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let rows;
    try { rows = parseInventoryCsv(text); }
    catch (error) { e.target.value = ''; return alert(`${error.message}\n未匯入任何資料。`); }
    if (!rows.length) { e.target.value = ''; return alert('檔案沒有庫存資料。'); }
    const preview = rows.slice(0, 5).map(row => `${row.material}：${row.stock} ${row.unit}`).join('\n');
    if (!window.confirm(`準備匯入 ${rows.length} 個品項；同名品項將更新庫存。\n${preview}${rows.length > 5 ? '\n…' : ''}\n確定匯入？`)) { e.target.value = ''; return; }
    rows.forEach((row) => {
      const existing = state.inventoryItems.find((item) => (item.material || '').trim() === row.material);
      const payload = {
        id: existing?.id || crypto.randomUUID(),
        ...row,
        updatedAt: new Date().toLocaleString(),
      };
      if (existing) Object.assign(existing, payload);
      else state.inventoryItems.unshift(payload);
    });
    e.target.value = '';
    saveState();
    renderAll();
  });

  $('inventoryTbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-edit-inventory]');
    if (!btn) return;
    const item = state.inventoryItems.find((row) => row.id === btn.dataset.editInventory);
    if (!item) return;
    $('inventoryItemId').value = item.id;
    $('inventoryMaterial').value = item.material || '';
    $('inventoryCategory').value = item.category || '';
    $('inventoryStock').value = item.stock || '';
    $('inventoryUnit').value = item.unit || '';
    $('inventorySafetyStock').value = item.safetyStock || '';
    $('inventoryNote').value = item.note || '';
  });
}
