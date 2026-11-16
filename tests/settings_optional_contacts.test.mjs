import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function modules() {
  const context = vm.createContext({
    document: { documentElement: { style: { setProperty() {} } }, body: { dataset: {} } },
  });
  const shared = new vm.SourceTextModule(fs.readFileSync(new URL('../js/shared.js', import.meta.url), 'utf8'), { context });
  await shared.link(() => { throw new Error('unexpected shared import'); });
  await shared.evaluate();
  const statement = new vm.SourceTextModule(fs.readFileSync(new URL('../js/monthly-statement.js', import.meta.url), 'utf8'), { context });
  await statement.link(() => shared);
  await statement.evaluate();
  return { shared: shared.namespace, statement: statement.namespace };
}

test('explicitly cleared optional contacts remain empty after save and reload', async () => {
  const { shared } = await modules();
  const fields = ['companyAddress', 'companyPhone', 'companyEmail', 'companyWebsite', 'companyTaxId'];
  const data = Object.fromEntries(fields.map(field => [field, '   ']));
  const saved = shared.mergeSettings(data);
  const reloaded = shared.mergeSettings(JSON.parse(JSON.stringify(saved)));
  for (const field of fields) assert.equal(reloaded[field], '', field);
  shared.applyRuntimeBranding(reloaded);
  assert.equal(shared.COMPANY_INFO.address, '');
});

test('missing contact settings keep legacy defaults and required names keep their fallback', async () => {
  const { shared } = await modules();
  const defaults = shared.getDefaultSettings();
  const result = shared.mergeSettings({ companyAddress: null, companyName: '', companyPhone: undefined });
  assert.equal(result.companyAddress, defaults.companyAddress);
  assert.equal(result.companyPhone, defaults.companyPhone);
  assert.equal(result.companyEmail, defaults.companyEmail);
  assert.equal(result.companyName, defaults.companyName);
});

test('an explicitly blank address prints as unknown rather than the example address', async () => {
  const { shared, statement } = await modules();
  const settings = shared.mergeSettings({ companyAddress: '', companyPhone: '' });
  shared.applyRuntimeBranding(settings);
  const report = statement.buildMonthlyStatement({ customers: [{ id: 'customer', name: '客戶' }], orders: [] }, { customerId: 'customer', month: '2026-11' });
  const html = statement.statementPrintHtml(report, { name: settings.companyName, address: settings.companyAddress ?? shared.COMPANY_INFO.address, phone: settings.companyPhone });
  assert.match(html, /地址：-/);
  assert.match(html, /電話：-/);
  assert.doesNotMatch(html, /新北市中和區立言街53號|02-2222-2222/);
});
