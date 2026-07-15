import { $ } from './shared.js';

const ORDER_COMPANY_FIELDS = {
  billingCustomerInput: { label: '客人', role: '兩者' },
  upstreamInput: { label: '上游客戶', role: '上游' },
  downstreamInput: { label: '下游客戶', role: '下游' },
};

let dismissedMissingCustomerKey = '';

function normalizeCompanyName(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function findExactCustomerByName(state, name) {
  const key = normalizeCompanyName(name);
  if (!key) return null;
  return state.customers.find((customer) => normalizeCompanyName(customer.name) === key) || null;
}

function normalizeCustomerRole(role) {
  return role === '客人' ? '兩者' : String(role || '兩者');
}

function customerMatchesField(customer, fieldId) {
  const role = normalizeCustomerRole(customer.role);
  if (fieldId === 'downstreamInput') return ['下游', '兩者'].includes(role);
  return ['上游', '兩者'].includes(role);
}

function ensureCompanySuggestionList(input, fieldId) {
  const listId = `${fieldId}Suggestions`;
  let list = document.getElementById(listId);
  if (!list) {
    list = document.createElement('div');
    list.id = listId;
    list.className = 'order-company-suggestions hidden';
    list.setAttribute('role', 'listbox');
    input.parentElement?.classList.add('order-company-input-wrap');
    input.insertAdjacentElement('afterend', list);
  }
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', String(!list.classList.contains('hidden')));
  return list;
}

function hideCompanySuggestions(input, list) {
  list.classList.add('hidden');
  list.dataset.activeIndex = '-1';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderCompanySuggestions(state, input, fieldId, list) {
  const query = normalizeCompanyName(input.value);
  const customers = state.customers
    .filter((customer) => customer.active !== false && customerMatchesField(customer, fieldId))
    .filter((customer) => !query || normalizeCompanyName(customer.name).includes(query))
    .sort((a, b) => {
      const aStarts = normalizeCompanyName(a.name).startsWith(query) ? 0 : 1;
      const bStarts = normalizeCompanyName(b.name).startsWith(query) ? 0 : 1;
      return aStarts - bStarts || String(a.name).localeCompare(String(b.name), 'zh-Hant');
    })
    .slice(0, 8);

  list.replaceChildren(...customers.map((customer, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${list.id}Option${index}`;
    button.className = 'order-company-suggestion';
    button.dataset.customerName = customer.name || '';
    button.setAttribute('role', 'option');
    const name = document.createElement('strong');
    name.textContent = customer.name || '-';
    const detail = document.createElement('span');
    detail.textContent = [customer.phone, customer.address].filter(Boolean).join(' / ') || normalizeCustomerRole(customer.role);
    button.append(name, detail);
    return button;
  }));
  list.dataset.activeIndex = '-1';
  if (!customers.length) return hideCompanySuggestions(input, list);
  list.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function selectCompanySuggestion(input, list, button) {
  if (!button?.dataset.customerName) return;
  input.value = button.dataset.customerName;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  hideCompanySuggestions(input, list);
  input.focus({ preventScroll: true });
}

function moveCompanySuggestion(input, list, direction) {
  const options = [...list.querySelectorAll('.order-company-suggestion')];
  if (!options.length) return;
  const current = Number(list.dataset.activeIndex ?? -1);
  const next = Math.max(0, Math.min(options.length - 1, current + direction));
  options.forEach((option, index) => {
    const active = index === next;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-selected', String(active));
  });
  list.dataset.activeIndex = String(next);
  input.setAttribute('aria-activedescendant', options[next].id);
  options[next].scrollIntoView({ block: 'nearest' });
}

function bindCompanyAutocomplete(state, input, fieldId) {
  const list = ensureCompanySuggestionList(input, fieldId);
  input.addEventListener('focus', () => renderCompanySuggestions(state, input, fieldId, list));
  input.addEventListener('input', () => renderCompanySuggestions(state, input, fieldId, list));
  input.addEventListener('blur', () => window.setTimeout(() => hideCompanySuggestions(input, list), 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (list.classList.contains('hidden')) renderCompanySuggestions(state, input, fieldId, list);
      moveCompanySuggestion(input, list, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && Number(list.dataset.activeIndex) >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectCompanySuggestion(input, list, list.querySelectorAll('.order-company-suggestion')[Number(list.dataset.activeIndex)]);
      return;
    }
    if (event.key === 'Escape') hideCompanySuggestions(input, list);
  }, { capture: true });
  list.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('.order-company-suggestion');
    if (!button) return;
    event.preventDefault();
    selectCompanySuggestion(input, list, button);
  });
}

export function hideMissingCustomerPrompt() {
  const prompt = $('orderMissingCustomerPrompt');
  if (!prompt) return;
  prompt.classList.add('hidden');
  prompt.classList.remove('is-success');
  delete prompt.dataset.fieldId;
  delete prompt.dataset.customerName;
  delete prompt.dataset.customerRole;
  delete prompt.dataset.existingCustomerId;
}

function updateMissingCustomerPrompt(state, fieldId) {
  const config = ORDER_COMPANY_FIELDS[fieldId];
  const input = $(fieldId);
  const prompt = $('orderMissingCustomerPrompt');
  const text = $('orderMissingCustomerText');
  if (!config || !input || !prompt || !text) return;
  const name = input.value.trim();
  const exact = findExactCustomerByName(state, name);
  if (!name || (exact && exact.active !== false)) {
    if (!name || prompt.dataset.fieldId === fieldId) hideMissingCustomerPrompt();
    return;
  }

  const key = `${fieldId}:${normalizeCompanyName(name)}`;
  if (dismissedMissingCustomerKey === key) return hideMissingCustomerPrompt();
  const similar = state.customers
    .filter((customer) => customer.active !== false && (
      normalizeCompanyName(customer.name).includes(normalizeCompanyName(name))
      || normalizeCompanyName(name).includes(normalizeCompanyName(customer.name))
    ))
    .slice(0, 3)
    .map((customer) => customer.name);

  prompt.dataset.fieldId = fieldId;
  prompt.dataset.customerName = name;
  prompt.dataset.customerRole = config.role;
  prompt.dataset.existingCustomerId = exact?.id || '';
  prompt.classList.remove('hidden', 'is-success');
  text.textContent = exact
    ? `公司「${name}」目前已停用，要重新啟用嗎？`
    : `找不到${config.label}「${name}」，要新增到客戶資料嗎？${similar.length ? ` 可能相近：${similar.join('、')}。` : ''}`;
  $('addMissingCustomerBtn').textContent = exact ? '重新啟用' : '新增公司';
}

function addMissingCustomerFromOrder(state, saveState, renderAll) {
  const prompt = $('orderMissingCustomerPrompt');
  const text = $('orderMissingCustomerText');
  const name = prompt?.dataset.customerName?.trim() || '';
  if (!prompt || !text || !name) return;
  const existing = findExactCustomerByName(state, name);
  const reactivated = existing?.active === false;
  if (existing) {
    existing.active = true;
  } else {
    state.customers.push({
      id: crypto.randomUUID(),
      name,
      role: prompt.dataset.customerRole || '兩者',
      taxId: '',
      phone: '',
      address: '',
      active: true,
    });
  }
  dismissedMissingCustomerKey = '';
  saveState();
  renderAll();
  prompt.classList.remove('hidden');
  prompt.classList.add('is-success');
  text.textContent = reactivated
    ? `已重新啟用「${name}」。`
    : `已新增「${name}」。之後可到客戶資料補上統編、電話與地址。`;
  $('addMissingCustomerBtn').textContent = reactivated ? '已啟用' : '已新增';
  window.setTimeout(() => {
    if (prompt.dataset.customerName === name) hideMissingCustomerPrompt();
  }, 1800);
}

export function bindMissingCustomerEvents(state, saveState, renderAll) {
  Object.keys(ORDER_COMPANY_FIELDS).forEach((fieldId) => {
    const input = $(fieldId);
    if (!input) return;
    bindCompanyAutocomplete(state, input, fieldId);
    input.addEventListener('blur', () => updateMissingCustomerPrompt(state, fieldId));
    input.addEventListener('input', () => {
      const prompt = $('orderMissingCustomerPrompt');
      if (prompt?.dataset.fieldId === fieldId && prompt.dataset.customerName !== input.value.trim()) hideMissingCustomerPrompt();
    });
  });
  $('addMissingCustomerBtn')?.addEventListener('click', () => addMissingCustomerFromOrder(state, saveState, renderAll));
  $('dismissMissingCustomerBtn')?.addEventListener('click', () => {
    const prompt = $('orderMissingCustomerPrompt');
    dismissedMissingCustomerKey = `${prompt?.dataset.fieldId || ''}:${normalizeCompanyName(prompt?.dataset.customerName)}`;
    hideMissingCustomerPrompt();
  });
}
