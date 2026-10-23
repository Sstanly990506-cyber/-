import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

async function harness(fetch, events = [], hooks = {}) {
  const context = vm.createContext({
    fetch, console, setTimeout, clearTimeout, setInterval,
    queueMicrotask: () => {},
    document: { getElementById: () => null },
    window: { dispatchEvent: event => events.push(event.type), alert: hooks.alert },
    Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: () => '{invalid', setItem: () => {} },
  });
  const shared = new vm.SyntheticModule(['formatTs', 'getTodayText', 'getDefaultSettings', 'mergeSettings'], function () {
    this.setExport('formatTs', () => 'now');
    this.setExport('getTodayText', () => '2026-10-03');
    this.setExport('getDefaultSettings', () => ({}));
    this.setExport('mergeSettings', (value) => value);
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/store.js', import.meta.url), 'utf8'), { context });
  await module.link(() => shared);
  await module.evaluate();
  const store = module.namespace;
  store.configureStore({ refreshFn: () => {}, syncUiFn: hooks.syncUiFn || (() => {}) });
  store.setAuthToken('first-account');
  store.state.allowedViews = ['customersView'];
  store.hydrateBootstrap({ initialPages: { customers: { items: [{ id: 'c1', name: 'original' }] } } });
  return store;
}

const response = (data = {}) => ({ ok: true, json: async () => data });

test('audit CSV preserves quoted commas, newlines and escaped quotes', async () => {
  const context = vm.createContext({});
  const shared = new vm.SyntheticModule(['$', 'downloadCsv', 'escapeHtml'], function () {
    for (const name of ['$', 'downloadCsv', 'escapeHtml']) this.setExport(name, () => {});
  }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/audit.js', import.meta.url), 'utf8'), { context });
  await module.link(() => shared);
  await module.evaluate();
  const rows = module.namespace.parseAuditCsv('\uFEFF"a","b"\r\n"WO1","note, line\nnext ""quote"""\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'note, line\nnext "quote"');
  assert.throws(() => module.namespace.parseAuditCsv('"unfinished'), /CSV/);
});

test('read-only trip data is not written back by client normalization', async () => {
  let count = 0;
  const store = await harness(async () => { count += 1; return response(); });
  store.state.userRole = 'driver';
  store.state.allowedViews = ['tripsView'];
  store.state.orders = [{ id: 'o1', status: '已完成' }];
  await store.saveState();
  assert.equal(count, 0);
});

test('consecutive edits during a write are sent in order', async () => {
  let release;
  const calls = [];
  const store = await harness(async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return response();
  });
  store.state.customers[0].name = 'first edit';
  const first = store.saveState();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  store.state.customers[0].name = 'second edit';
  const second = store.saveState();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls.map((row) => row.name), ['first edit', 'second edit']);
  await store.saveState();
  assert.equal(calls.length, 2);
});

test('remote changes cannot overwrite an unsaved local edit', async () => {
  const store = await harness(async () => response({ cursor: 1, changes: [{ entity: 'customers', id: 'c1', data: { name: 'remote' }, updatedAt: 1 }] }));
  store.state.customers[0].name = 'local edit';
  await store.pullServerState();
  assert.equal(store.state.customers[0].name, 'local edit');
});

test('switching accounts discards an old in-flight page response', async () => {
  let release;
  const store = await harness(async () => {
    await new Promise((resolve) => { release = resolve; });
    return response({ items: [{ id: 'old', name: 'private old account' }] });
  });
  const pending = store.loadEntityPage('customers');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  store.setAuthToken('second-account');
  release();
  await pending;
  assert.equal(store.state.customers.length, 0);
});

test('invalid saved UI JSON does not block initialization', async () => {
  const store = await harness(async () => response());
  assert.doesNotThrow(() => store.initializeStore());
});

test('finance unlock loads complete data without resetting the current order page', async () => {
  const records = { orders: [{ id: 'o1' }, { id: 'o2' }], customers: [], receivables: [{ id: 'r1', amount: 20 }], payables: [], audits: [] };
  const store = await harness(async () => response({ records }));
  store.state.orders = [{ id: 'visible-order' }];
  store.state.userRole = 'finance';
  store.state.allowedViews = ['financeView'];
  await store.unlockFinanceSession('unlocked-account', Math.floor(Date.now() / 1000) + 900);
  assert.equal(store.state.orders[0].id, 'visible-order');
  assert.equal(store.state.financeRecords.orders.length, 2);
  assert.equal(store.state.receivables.length, 1);
});

test('finance data from an old account is discarded after switching accounts', async () => {
  let release;
  const store = await harness(async () => {
    await new Promise(resolve => { release = resolve; });
    return response({ records: { orders: [{ id: 'private' }], receivables: [{ id: 'private-receivable' }], payables: [] } });
  });
  const pending = store.unlockFinanceSession('unlocked', Math.floor(Date.now() / 1000) + 900);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  store.setAuthToken('second-account');
  release(); await pending;
  assert.equal(store.state.financeRecords, null);
  assert.equal(store.state.receivables.length, 0);
});

test('expired finance data is removed without contacting the server', async () => {
  let calls = 0;
  const store = await harness(async () => { calls++; return response(); });
  store.state.financeUntil = Date.now() - 1;
  store.state.financeRecords = { orders: [{ id: 'private' }] };
  store.state.receivables = [{ id: 'private-r' }];
  await store.loadFinanceData();
  assert.equal(calls, 0);
  assert.equal(store.state.financeRecords, null);
  assert.equal(store.state.receivables.length, 0);
});

test('an old unauthorized response cannot log out the new account', async () => {
  let release;
  const events = [];
  const store = await harness(async () => {
    await new Promise(resolve => { release = resolve; });
    return { ok: false, status: 401, json: async () => ({ error: 'old expired session' }) };
  }, events);
  const pending = store.loadEntityPage('customers');
  const rejected = assert.rejects(pending, /old expired session/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  store.setAuthToken('second-account'); events.length = 0;
  release(); await rejected;
  assert.equal(events.includes('app:session-expired'), false);
  assert.equal(store.state.authToken, 'second-account');
});

test('a pending finance unlock cannot replace an account switched during a save', async () => {
  let release;
  const store = await harness(async () => {
    await new Promise(resolve => { release = resolve; });
    return response();
  });
  store.state.customers[0].name = 'pending edit';
  const save = store.saveState();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const unlock = store.unlockFinanceSession('old-unlocked-account', Math.floor(Date.now() / 1000) + 900);
  const rejected = assert.rejects(unlock, /登入已變更/);
  store.setAuthToken('second-account');
  release(); await Promise.all([save, rejected]);
  assert.equal(store.state.authToken, 'second-account');
  assert.equal(store.state.financeUntil, 0);
});

test('successful saves advance the version without discarding edits made in flight', async () => {
  let release;
  const calls = [];
  const store = await harness(async (url, options) => {
    if (url === '/api/dashboard') return response({summary:{pendingOrders:51}});
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return response({updatedAt:100 + calls.length});
  });
  store.state.customers[0].name = 'first';
  const first = store.saveState();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  store.state.customers[0].name = 'second';
  const second = store.saveState();
  release(); await Promise.all([first,second]);
  assert.equal(calls[0]._expectedVersion,0);
  assert.equal(calls[1]._expectedVersion,101);
  assert.equal(store.state.customers[0]._updatedAt,102);
  await store.saveState();
  assert.equal(calls.length,2);
});

test('a conflict preserves the draft and retries with the original version', async () => {
  const calls = [];
  const store = await harness(async (url, options) => {
    calls.push(JSON.parse(options.body));
    return {ok:false,status:409,json:async()=>({error:'conflict',conflict:true})};
  });
  store.state.customers[0].name = 'draft';
  await store.saveState(); await store.saveState();
  assert.equal(store.state.customers[0].name,'draft');
  assert.equal(calls.length,2);
  assert.equal(calls[1]._expectedVersion,calls[0]._expectedVersion);
});

test('changing a list page leaves the complete dashboard summary unchanged', async () => {
  const store = await harness(async () => response({items:[],page:2,pages:2,total:150}));
  store.state.dashboardSummary = {pendingOrders:51};
  await store.loadEntityPage('customers',2);
  assert.equal(store.state.dashboardSummary.pendingOrders,51);
});

test('a late incremental response cannot roll back a completed local save', async () => {
  let releasePull;
  const writes=[];
  const store=await harness(async (url,options) => {
    if(url.startsWith('/api/changes')) {
      await new Promise(resolve => { releasePull=resolve; });
      return response({cursor:100,changes:[{entity:'customers',id:'c1',data:{id:'c1',name:'original',taxId:''},updatedAt:100}]});
    }
    if(url==='/api/dashboard') return response({summary:{}});
    writes.push(JSON.parse(options.body));return response({updatedAt:101});
  });
  store.hydrateBootstrap({syncTick:100,initialPages:{customers:{items:[{id:'c1',name:'original',taxId:'',_updatedAt:100}]}}});
  const pull=store.pullServerState();while(!releasePull) await new Promise(resolve=>setImmediate(resolve));
  store.state.customers[0].name='saved edit';await store.saveState();
  releasePull();await pull;
  assert.equal(store.state.customers[0].name,'saved edit');
  assert.equal(store.state.customers[0]._updatedAt,101);
});

test('normalizing during a pending write does not trigger an extra write or leave an obsolete version', async () => {
  let release;
  const writes=[];
  const store=await harness(async(url,options)=>{
    if(url==='/api/dashboard')return response({summary:{}});
    writes.push(JSON.parse(options.body));
    if(writes.length===1)await new Promise(resolve=>{release=resolve;});
    return response({updatedAt:100+writes.length});
  });
  store.state.customers[0].name='edit';const first=store.saveState();
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const second=store.saveState();release();await Promise.all([first,second]);
  assert.equal(writes.length,1);assert.equal(store.state.customers[0]._updatedAt,101);
});

test('repeated identical conflicts alert once, preserve the draft, and never show saved', async () => {
  const alerts=[],ui=[];
  const store=await harness(async(url)=>{
    if(url.startsWith('/api/changes'))return response({cursor:200,changes:[]});
    if(url==='/api/dashboard')return response({summary:{}});
    return {ok:false,status:409,json:async()=>({error:'資料已由其他人更新',conflict:true})};
  },[],{alert:message=>alerts.push(message),syncUiFn:status=>ui.push(status)});
  store.state.customers[0].name='draft';
  await store.saveState();store.state.customers[0].updatedAt='new display time';await store.saveState();
  assert.equal(alerts.length,1);assert.match(alerts[0],/draft/);
  await store.pullServerState();
  assert.equal(store.state.customers[0].name,'draft');
  assert.equal(ui.at(-1).ok,false);assert.equal(ui.at(-1).badgeText,'修改尚未儲存');
  store.state.customers[0].name='revised draft';await store.saveState();assert.equal(alerts.length,2);
});

test('a stale deletion cannot remove a newer saved record', async () => {
  const store=await harness(async(url)=>{
    if(url.startsWith('/api/changes'))return response({cursor:150,changes:[{entity:'customers',id:'c1',deleted:true,updatedAt:100}]});
    return response({summary:{}});
  });
  store.hydrateBootstrap({syncTick:150,initialPages:{customers:{items:[{id:'c1',name:'newer',taxId:'',_updatedAt:150}]}}});
  await store.pullServerState();assert.equal(store.state.customers[0].name,'newer');
});

test('conflict from a previous account cannot alert or change the new account sync badge', async () => {
  let release;const alerts=[],ui=[];
  const store=await harness(async()=>{
    await new Promise(resolve=>{release=resolve;});
    return {ok:false,status:409,json:async()=>({error:'conflict',conflict:true})};
  },[],{alert:message=>alerts.push(message),syncUiFn:status=>ui.push(status)});
  store.state.customers[0].name='private draft';const save=store.saveState();
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  store.setAuthToken('second-account');const notices=ui.length;release();await save;
  assert.equal(alerts.length,0);assert.equal(ui.length,notices);
});

async function orderHarness(fetch) {
  const store=await harness(fetch);
  store.state.allowedViews=['ordersView'];
  store.hydrateBootstrap({initialPages:{customers:{items:[]},priceRules:{items:[]},orders:{items:[{id:'o1',orderNumber:'A',sortOrder:0,_updatedAt:100},{id:'o2',orderNumber:'B',sortOrder:1,_updatedAt:101}]}}});
  return store;
}

test('sorting sends one guarded batch and commits both row versions without extra writes', async()=>{
  const calls=[];
  const store=await orderHarness(async(url,options)=>{
    calls.push({url,options});
    return response({ok:true,updatedAt:200,orders:[{id:'o2',sortOrder:0},{id:'o1',sortOrder:1}]});
  });
  await store.saveOrderSortOrder(['o2','o1'],{o1:100,o2:101});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/orders/reorder');
  assert.deepEqual(JSON.parse(calls[0].options.body).orders,[{id:'o2',_expectedVersion:101},{id:'o1',_expectedVersion:100}]);
  assert.equal(store.state.orders[0].sortOrder,1);assert.equal(store.state.orders[1].sortOrder,0);
  assert.equal(store.state.orders[0]._updatedAt,200);await store.saveState();assert.equal(calls.length,1);
});

test('a rejected sorting batch leaves all local positions and versions unchanged',async()=>{
  const store=await orderHarness(async()=>({ok:false,status:409,json:async()=>({error:'changed by another operator',conflict:true})}));
  await assert.rejects(store.saveOrderSortOrder(['o2','o1'],{o1:100,o2:101}),/another operator/);
  assert.equal(store.state.orders[0].sortOrder,0);assert.equal(store.state.orders[1].sortOrder,1);
  assert.equal(store.state.orders[0]._updatedAt,100);
});

test('dirty orders block sorting rather than overwrite unsaved edits',async()=>{
  let calls=0;const store=await orderHarness(async()=>{calls++;return response();});
  store.state.orders[0].itemName='unsaved';
  await assert.rejects(store.saveOrderSortOrder(['o2','o1'],{o1:100,o2:101}),/未儲存/);
  assert.equal(calls,0);assert.equal(store.state.orders[0].itemName,'unsaved');
});

test('order deletion sends the viewed version and restores the row on stale-delete rejection',async()=>{
  const calls=[];
  const store=await orderHarness(async(url,options)=>{
    calls.push({url,options});return {ok:false,status:409,json:async()=>({error:'delete cancelled',conflict:true})};
  });
  store.state.orders.splice(0,1);await store.saveState();
  assert.equal(calls[0].url,'/api/data/orders/o1?expectedVersion=100');
  assert.equal(calls[0].options.method,'DELETE');
  assert(store.state.orders.some(row=>row.id==='o1'));
});

test('edits made while a sorting request is pending survive and use the committed batch version',async()=>{
  let release;const writes=[];
  const store=await orderHarness(async(url,options)=>{
    if(url==='/api/orders/reorder'){
      await new Promise(resolve=>{release=resolve;});
      return response({ok:true,updatedAt:200,orders:[{id:'o2',sortOrder:0},{id:'o1',sortOrder:1}]});
    }
    if(url==='/api/dashboard')return response({summary:{}});
    writes.push(JSON.parse(options.body));return response({updatedAt:201});
  });
  const sorting=store.saveOrderSortOrder(['o2','o1'],{o1:100,o2:101});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  store.state.orders[0].itemName='new edit';const save=store.saveState();release();
  await Promise.all([sorting,save]);
  assert.equal(writes.length,1);assert.equal(writes[0]._expectedVersion,200);
  assert.equal(writes[0].sortOrder,1);assert.equal(store.state.orders[0].itemName,'new edit');
});

test('relative movement is not blocked by unrelated unsaved orders and uses no stale list versions',async()=>{
  const calls=[];
  const store=await orderHarness(async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return response({ok:true,orders:[{id:'o1',orderNumber:'A',sortOrder:2,_updatedAt:200}]});
  });
  store.state.orders[1].itemName='unsaved different order';
  await store.moveOrder('o1','o2',true);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/orders/move');
  assert.deepEqual(calls[0].body,{id:'o1',targetId:'o2',after:true});
  assert.equal(store.state.orders[0].sortOrder,2);
  assert.equal(store.state.orders[1].itemName,'unsaved different order');
});

test('relative move merges latest server content into clean rows and creates no extra writes',async()=>{
  const calls=[];const store=await orderHarness(async(url)=>{
    calls.push(url);return response({ok:true,orders:[{id:'o1',orderNumber:'A',itemName:'other user edit',sortOrder:2,totalPrice:200,_updatedAt:200}]});
  });
  await store.moveOrder('o1','o2',true);await store.saveState();
  assert.equal(store.state.orders[0].itemName,'other user edit');assert.equal(store.state.orders[0]._updatedAt,200);
  assert.equal(calls.length,1);
});

test('moving a locally edited row retains the draft and advances its version only when business data agrees',async()=>{
  const store=await orderHarness(async()=>response({ok:true,orders:[{id:'o1',orderNumber:'A',sortOrder:2,_updatedAt:200}]}));
  store.state.orders[0].itemName='local draft';await store.moveOrder('o1','o2',true);
  assert.equal(store.state.orders[0].itemName,'local draft');assert.equal(store.state.orders[0]._updatedAt,200);
  assert.equal(store.state.orders[0].sortOrder,2);
});

test('a move never silently resolves a conflicting business edit by granting a newer save version',async()=>{
  const writes=[];const store=await orderHarness(async(url,options)=>{
    if(url==='/api/orders/move')return response({ok:true,orders:[{id:'o1',orderNumber:'A',itemName:'remote conflicting edit',sortOrder:2,_updatedAt:200}]});
    writes.push(JSON.parse(options.body));return {ok:false,status:409,json:async()=>({error:'conflict',conflict:true})};
  });
  store.state.orders[0].itemName='local draft';await store.moveOrder('o1','o2',true);await store.saveState();
  assert.equal(store.state.orders[0].itemName,'local draft');assert.equal(store.state.orders[0]._updatedAt,100);
  assert.equal(writes[0]._expectedVersion,100);assert.equal(writes[0].sortOrder,2);
});

test('another user moving a row rebases only its sort metadata while retaining our pending edit',async()=>{
  const writes=[];const store=await orderHarness(async(url,options)=>{
    if(url.startsWith('/api/changes'))return response({cursor:200,changes:[{entity:'orders',id:'o1',data:{id:'o1',orderNumber:'A',sortOrder:3},updatedAt:200}]});
    if(url==='/api/dashboard')return response({summary:{}});
    writes.push(JSON.parse(options.body));return response({updatedAt:201});
  });
  store.state.orders[0].itemName='my edit';await store.pullServerState();
  assert.equal(store.state.orders[0].itemName,'my edit');assert.equal(store.state.orders[0]._updatedAt,200);
  await store.saveState();assert.equal(writes[0]._expectedVersion,200);assert.equal(writes[0].sortOrder,3);
});
