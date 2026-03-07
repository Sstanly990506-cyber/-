import { $ } from './shared.js';

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
    const role = $('customerRole').value || '上游';
    const phone = $('customerPhone').value.trim();
    const address = $('customerAddress').value.trim();
    state.customers.push({ id: crypto.randomUUID(), name, role, phone, address, active: true });
    saveState();
    e.target.reset();
    renderAll();
  });

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
}
