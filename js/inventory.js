import { $, money } from './shared.js';

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

export function renderInventory(state) {
  const body = $('inventoryTbody');
  const items = state.inventoryItems || [];
  if ($('inventoryItemsCount')) $('inventoryItemsCount').textContent = String(items.length);
  if ($('inventoryLowCount')) $('inventoryLowCount').textContent = String(items.filter((item) => Number(item.stock || 0) <= Number(item.safetyStock || 0)).length);
  if ($('inventoryStockValue')) $('inventoryStockValue').textContent = `合計 ${money(items.reduce((sum, item) => sum + Number(item.stock || 0), 0))}`;
  if (!body) return;
  body.innerHTML = items.map((item) => {
    const low = Number(item.stock || 0) <= Number(item.safetyStock || 0);
    return `<tr>
      <td>${item.material || '-'}</td>
      <td>${item.category || '-'}</td>
      <td>${money(item.stock)} ${item.unit || ''}</td>
      <td>${money(item.safetyStock)} ${item.unit || ''}</td>
      <td><span class="tag ${low ? 'warn' : ''}">${low ? '低庫存' : '正常'}</span></td>
      <td>${item.note || '-'}</td>
      <td>${item.updatedAt || '-'}</td>
      <td><button class="btn" data-edit-inventory="${item.id}">編輯</button></td>
    </tr>`;
  }).join('');
}

export function bindInventoryEvents(state, saveState, renderAll) {
  $('inventoryForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const item = buildItem(state);
    if (!item.material) return alert('請輸入品項名稱');
    const idx = state.inventoryItems.findIndex((row) => row.id === item.id);
    if (idx >= 0) state.inventoryItems[idx] = item;
    else state.inventoryItems.unshift(item);
    saveState();
    clearInventoryForm();
    renderAll();
  });

  $('inventoryClearBtn')?.addEventListener('click', clearInventoryForm);

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
