import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ Map, Number, String });
const module = new vm.SourceTextModule(fs.readFileSync(new URL('../js/monthly-statement.js', import.meta.url), 'utf8'), { context });
const shared = new vm.SyntheticModule(['escapeHtml'], function () {
  this.setExport('escapeHtml', value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'));
}, { context });
await module.link(() => shared);
await module.evaluate();
const { buildMonthlyStatement, statementPrintHtml, fetchStatementRecords } = module.namespace;
const customer = { id: 'c1', name: '甲公司', phone: '2223-4568', fax: '2223-5678', taxId: '12345678', address: '地址' };
const order = { id: 'o1', billingCustomer: '甲公司', orderDate: '2026-09-01', orderNumber: '001', status: '已完成', itemName: '紙盒', glossType: 'PVA光', sheetCount: 1000, unitPrice: 936, pricingMode: 'ream', totalPrice: 1000, downstream: '軋盒廠' };

test('bill uses exact customer, month and completed/sent orders, not current price rules', () => {
  const state = { customers: [customer], orders: [order, { ...order, id: '2', billingCustomer: '甲公司二' }, { ...order, id: '3', status: '未完成' }, { ...order, id: '4', orderDate: '2026-08-01' }, { ...order, id: '5', status: '已送出', totalPrice: 501 }] };
  const bill = buildMonthlyStatement(state, { customerId: 'c1', month: '2026-09' });
  assert.equal(bill.rows.length, 2);
  assert.equal(bill.subtotal, 1501);
  assert.equal(bill.tax, 75);
  assert.equal(bill.total, 1576);
  assert.equal(bill.rows[0].unitPrice, 936);
  assert.equal(buildMonthlyStatement(state, { customerId: 'c1', month: '2026-09', taxRate: 0, includePending: true }).rows.length, 3);
});

test('legacy missing unit prices are flagged; customer matching never falls back to downstream', () => {
  const bill = buildMonthlyStatement({ customers: [customer], orders: [{ ...order, unitPrice: undefined }, { ...order, id: '2', billingCustomer: '', upstream: '', downstream: customer.name }] }, { customerId: 'c1', month: '2026-09' });
  assert.equal(bill.rows.length, 1);
  assert.equal(bill.rows[0].unitPrice, null);
  assert.match(bill.warnings.join(''), /單價/);
  assert.throws(() => buildMonthlyStatement({ customers: [customer] }, { customerId: 'c1', month: 'bad' }));
});

test('print report includes full contact details and escapes record text', () => {
  const bill = buildMonthlyStatement({ customers: [customer], orders: [{ ...order, itemName: '<script>bad</script>' }] }, { customerId: 'c1', month: '2026-09' });
  const html = statementPrintHtml(bill, { name: '三青實業有限公司', phone: '2223-4568', fax: '3234-6736', address: '立言街53號' });
  for (const text of ['月帳單報表', '統一編號', '12345678', '2223-5678', '應付金額', '送貨地點', '元／令']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>bad'));
});

test('photo example total and configurable tax match the monthly bill', () => {
  const state = { customers: [customer], orders: [{ ...order, totalPrice: 86011 }] };
  const bill = buildMonthlyStatement(state, { customerId: 'c1', month: '2026-09' });
  assert.equal(bill.tax, 4301);
  assert.equal(bill.total, 90312);
  assert.equal(buildMonthlyStatement(state, { customerId: 'c1', month: '2026-09', taxRate: 0 }).total, 86011);
  assert.throws(() => buildMonthlyStatement({ ...state, customers: [customer, { ...customer, id: 'c2' }] }, { customerId: 'c1', month: '2026-09' }), /同名客戶/);
});

test('reads every page without changing the main order list; failures do not return partial bills', async () => {
  let calls = 0;
  const request = async () => ({ ok: true, json: async () => ({ pages: 2, items: [{ id: `o${++calls}` }] }) });
  const rows = await fetchStatementRecords('orders', 'token', '甲公司', request);
  assert.equal(rows.length, 2);
  await assert.rejects(fetchStatementRecords('orders', 'token', '', async () => ({ ok: false, status: 403 })), /403/);
});

test('including pending orders never bills cancelled orders', () => {
  const bill = buildMonthlyStatement({ customers: [customer], orders: [order, { ...order, id: 'cancelled', status: '已取消' }, { ...order, id: 'pending', status: '未完成' }] }, { customerId: 'c1', month: '2026-09', includePending: true });
  assert.deepEqual(Array.from(bill.rows, row => row.id).sort(), ['o1', 'pending']);
});
