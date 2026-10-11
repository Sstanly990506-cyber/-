import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ Map, Number, String, Date });
const source = new vm.SourceTextModule(fs.readFileSync(new URL('../js/finance.js', import.meta.url), 'utf8'), { context });
const exports = ['$', 'COMPANY_INFO', 'money', 'downloadCsv', 'getTodayText', 'escapeHtml', 'getOrderReceivableKey', 'isRecordDirty', 'toTaiInch', 'buildMonthlyStatement', 'fetchStatementRecords', 'statementTableHtml', 'statementPrintHtml'];
const imports = new vm.SyntheticModule(exports, function () {
  for (const name of exports) this.setExport(name, name === 'isRecordDirty' ? row => false : () => {});
}, { context });
await source.link(() => imports);
await source.evaluate();
const { reportState, getReportBData, getInvoiceEligibleOrders } = source.namespace;
const orders = Array.from({ length: 603 }, (_, i) => ({ id: String(i), orderNumber: String(i), totalPrice: 100, actualCost: 40, status: '已完成', _updatedAt: 2 }));
const state = { orders: [orders[0]], customers: [], receivables: [], payables: [], audits: [], reportRange: { start: '', end: '' }, financeRecords: { orders, customers: [], receivables: [], payables: [], audits: [] } };

test('finance reports and invoice picker include records beyond the loaded order page', () => {
  assert.equal(getReportBData(state).length, 603);
  assert.equal(getInvoiceEligibleOrders(state).length, 603);
  assert.equal(state.orders.length, 1);
  assert.equal(getReportBData(state).reduce((total, row) => total + row.gross, 0), 603 * 60);
});

test('gross profit uses actual cost and leaves missing or invalid cost unknown', () => {
  const data = { ...state, financeRecords: null, orders: [
    { totalPrice: 100, actualCost: 15 }, { totalPrice: 100, actualCost: 0 },
    ...[undefined, null, '', -1, 'invalid', Infinity].map(actualCost => ({ totalPrice: 100, actualCost })),
  ] };
  const margins = getReportBData(data);
  assert.equal(margins[0].gross, 85);
  assert.equal(margins[1].gross, 100);
  for (const row of margins.slice(2)) { assert.equal(row.cost, null); assert.equal(row.gross, null); }
});

test('invoice selection agrees with completed and sent status labels', () => {
  const data = { ...state, financeRecords: null, orders: ['已完成', '已送出', '未完成', '進行中', '已取消'].map(status => ({ status })) };
  assert.deepEqual(Array.from(getInvoiceEligibleOrders(data), row => row.status), ['已完成', '已送出']);
});

test('a stale loaded order does not overwrite a newer complete report record', () => {
  const data = { ...state, orders: [{ ...orders[0], totalPrice: 1, _updatedAt: 1 }] };
  assert.equal(reportState(data).orders[0].totalPrice, 100);
});

test('deleting an account payable does not resurrect it from the report snapshot', () => {
  const data = { ...state, payables: [], financeRecords: { ...state.financeRecords, payables: [{ id: 'deleted', amount: 100 }] } };
  assert.equal(reportState(data).payables.length, 0);
});

const tripModule = new vm.SourceTextModule(fs.readFileSync(new URL('../js/trips/core.js', import.meta.url), 'utf8'), { context });
await tripModule.link(() => { throw new Error('unexpected trip dependency'); });
await tripModule.evaluate();

test('offline route preserves addresses and never invents travel metrics', () => {
  const factory = { id: 'factory', address: '新北市中和區立言街53號' };
  const stops = [{ id: 'pickup', type: 'pickup', address: '地址甲' }, { id: 'delivery', type: 'delivery', address: '地址乙' }];
  const result = tripModule.namespace.optimizeTrip(factory, stops);
  assert.equal(result.bestRoute.totalDistanceM, null);
  assert.equal(result.bestRoute.totalDurationSec, null);
  assert.deepEqual(Array.from(result.bestRoute.orderedStops, row => row.id), ['factory', 'delivery', 'pickup', 'factory']);
  assert.equal(new URL(result.googleMapsUrl).searchParams.get('origin'), factory.address);
  assert.throws(() => tripModule.namespace.optimizeTrip(factory, [{ ...stops[0], address: '-' }]), /地址/);
});
