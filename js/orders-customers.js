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
    $(fieldId)?.addEventListener('blur', () => updateMissingCustomerPrompt(state, fieldId));
    $(fieldId)?.addEventListener('input', () => {
      const prompt = $('orderMissingCustomerPrompt');
      if (prompt?.dataset.fieldId === fieldId && prompt.dataset.customerName !== $(fieldId).value.trim()) hideMissingCustomerPrompt();
    });
  });
  $('addMissingCustomerBtn')?.addEventListener('click', () => addMissingCustomerFromOrder(state, saveState, renderAll));
  $('dismissMissingCustomerBtn')?.addEventListener('click', () => {
    const prompt = $('orderMissingCustomerPrompt');
    dismissedMissingCustomerKey = `${prompt?.dataset.fieldId || ''}:${normalizeCompanyName(prompt?.dataset.customerName)}`;
    hideMissingCustomerPrompt();
  });
}
