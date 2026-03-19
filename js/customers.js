import { $ } from './shared.js';

function getCustomerRoles(state) {
  const roles = state.settings?.moduleInternals?.customers?.roles || { '上游': true, '下游': true, '兩者': true };
  const items = ['上游', '下游', '兩者'].filter((role) => roles[role] !== false);
  return items.length ? items : ['上游'];
}

function renderCustomerRoleOptions(state) {
  const select = $('customerRole');
  if (!select) return;
  const roles = getCustomerRoles(state);
  const current = select.value;
  select.innerHTML = roles.map((role) => `<option value="${role}">${role}</option>`).join('');
  select.value = roles.includes(current) ? current : roles[0];
}

function normalizePhone(phone = '') {
  return phone.replace(/[^\d+]/g, '');
}

function inferRoleFromHistory(state, name) {
  const key = (name || '').trim();
  if (!key) return null;
  const asUp = state.orders.some((o) => (o.upstream || '').trim() === key);
  const asDown = state.orders.some((o) => (o.downstream || '').trim() === key);
  if (asUp && asDown) return '兩者';
  if (asUp) return '上游';
  if (asDown) return '下游';
  return null;
}

function updateCustomerSmartHint(state) {
  const hint = $('customerSmartHint');
  if (!hint) return;
  const name = $('customerName')?.value.trim() || '';
  if (!name) {
    hint.textContent = '智能建議：可直接輸入電話與地址，系統會避免重複客戶。';
    return;
  }

  const existed = state.customers.find((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase());
  if (existed) {
    hint.textContent = `智能提醒：客戶「${name}」已存在（目前${existed.active === false ? '停用' : '啟用'}）。`;
    return;
  }

  const role = inferRoleFromHistory(state, name);
  if (role) {
    hint.textContent = `智能建議：歷史工單顯示「${name}」常用角色為「${role}」，已幫你預選。`;
    const roles = getCustomerRoles(state);
    if (roles.includes(role)) $('customerRole').value = role;
    return;
  }

  hint.textContent = `智能建議：尚無「${name}」歷史資料，請確認角色/地址後新增。`;
}

export function renderCustomerOptions(state) {
  const upstream = $('upstreamOptions');
  const downstream = $('downstreamOptions');
  if (!upstream || !downstream) return;
  upstream.innerHTML = '';
  downstream.innerHTML = '';
  const active = state.customers.filter((c) => c.active !== false);

  active
    .filter((c) => c.role === '上游' || c.role === '兩者')
    .forEach((c) => upstream.append(new Option(c.name, c.name)));
  active
    .filter((c) => c.role === '下游' || c.role === '兩者')
    .forEach((c) => downstream.append(new Option(c.name, c.name)));
}

export function renderCustomers(state) {
  renderCustomerRoleOptions(state);
  const body = $('customersTbody');
  if (!body) return;
  body.innerHTML = '';
  const keyword = ($('customerSearch')?.value || '').trim().toLowerCase();

  state.customers
    .filter((c) => {
      if (!keyword) return true;
      return [c.name, c.phone || '', c.address || ''].join(' ').toLowerCase().includes(keyword);
    })
    .forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
      <td>${c.name}</td>
      <td>${c.phone || '-'}</td>
      <td>${c.address || '-'}</td>
      <td>${c.role}</td>
      <td><span class="tag ${c.active === false ? 'off' : ''}">${c.active === false ? '停用' : '啟用'}</span></td>
      <td><button class="btn" data-toggle-customer="${c.id}">${c.active === false ? '啟用' : '停用'}</button></td>`;
      body.append(tr);
    });

  renderCustomerOptions(state);
}

export function bindCustomerEvents(state, saveState, renderAll) {
  $('customerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('customerName').value.trim() || '未命名客戶';
    const role = $('customerRole').value || getCustomerRoles(state)[0];
    const phone = normalizePhone($('customerPhone').value.trim());
    const address = $('customerAddress').value.trim();

    const duplicate = state.customers.find((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase());
    if (duplicate) {
      if (duplicate.active === false) {
        duplicate.active = true;
        duplicate.role = role || duplicate.role;
        duplicate.phone = phone || duplicate.phone;
        duplicate.address = address || duplicate.address;
        saveState();
        e.target.reset();
        updateCustomerSmartHint(state);
        renderAll();
        return alert(`已重新啟用既有客戶：${name}`);
      }
      return alert(`客戶已存在：${name}`);
    }

    state.customers.push({ id: crypto.randomUUID(), name, role, phone, address, active: true });
    saveState();
    e.target.reset();
    updateCustomerSmartHint(state);
    renderAll();
  });

  $('customerName')?.addEventListener('input', () => updateCustomerSmartHint(state));
  $('customerSearch')?.addEventListener('input', () => renderCustomers(state));

  $('customersTbody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-toggle-customer]');
    if (!btn) return;
    const customer = state.customers.find((c) => c.id === btn.dataset.toggleCustomer);
    if (!customer) return;
    customer.active = !customer.active;
    saveState();
    renderAll();
  });

  updateCustomerSmartHint(state);
}
