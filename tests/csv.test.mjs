import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const module = new vm.SourceTextModule(await readFile(new URL('../js/csv.js', import.meta.url), 'utf8'));
await module.link(() => { throw new Error('unexpected dependency'); });
await module.evaluate();
const { parseInventoryCsv } = module.namespace;
const header = '品項,分類,庫存,單位,安全庫存,備註,更新時間\r\n';

test('inventory reads its own quoted export including commas, newlines and quotes', () => {
  const rows = parseInventoryCsv('\uFEFF' + header + '"透明膜,厚型","膠膜",40,"卷",10,"第一行\n第二行 ""備註""",2026-10-15\r\n');
  assert.equal(rows.length,1);
  assert.equal(rows[0].material,'透明膜,厚型');
  assert.equal(rows[0].stock,40);
  assert.equal(rows[0].unit,'卷');
  assert.equal(rows[0].safetyStock,10);
  assert.equal(rows[0].note,'第一行\n第二行 "備註"');
});

test('inventory rejects the complete import if any row is malformed', () => {
  for (const row of ['B,film,wrong,kg,10,note,today','B,film,-1,kg,10,note,today','B,film,3,kg,10','"unfinished']) {
    assert.throws(() => parseInventoryCsv(header + 'A,film,40,kg,10,note,today\n' + row));
  }
  assert.throws(() => parseInventoryCsv(header + 'A,film,40,kg,10,note,today\nA,film,20,kg,10,note,today'), /重複/);
  assert.throws(() => parseInventoryCsv('wrong,headers\n1,2'), /欄位/);
});
