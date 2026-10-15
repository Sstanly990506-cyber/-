import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function harness() {
  const elements = new Map();
  function element() { return {value:'delivery',textContent:'',innerHTML:'',listeners:{},classList:{toggle(){}},append(){},addEventListener(name, handler){this.listeners[name] = handler;}}; }
  const $ = id => { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); };
  const requests = [], alerts = [], rendered = {route:[]};
  let pauseOptimize = null;
  const context = vm.createContext({console,Option:class{},document:{createElement:element},alert:message=>alerts.push(message),fetch:async(url,options)=>{
    const body = JSON.parse(options.body); requests.push({url,body});
    if (url === '/api/trips/execute') return {ok:true,json:async()=>({ok:true,updated:body.orderIds.length,orders:body.orderIds.map(id=>({id,status:'已送出'}))})};
    if (pauseOptimize) await pauseOptimize();
    return {ok:true,json:async()=>({notice:'fixture',bestRoute:{orderedStops:[body.factory,...body.stops,body.factory]}})};
  }});
  const core = new vm.SourceTextModule(await readFile(new URL('../js/trips/core.js', import.meta.url),'utf8'), {context});
  await core.link(()=>{throw new Error('unexpected core import');}); await core.evaluate();
  const exports = ['$', 'escapeHtml', 'DEFAULT_FACTORY', 'formatDistance', 'formatDuration', 'renderCustomerOptions', 'renderResult', 'renderManualRoute'];
  const deps = new vm.SyntheticModule(exports,function(){
    this.setExport('$',$);this.setExport('escapeHtml',String);
    this.setExport('DEFAULT_FACTORY',{id:'factory',name:'Factory',address:'Factory address'});
    for (const name of ['formatDistance','formatDuration','renderCustomerOptions','renderResult']) this.setExport(name,()=>{});
    this.setExport('renderManualRoute',(route,confirmed)=>{rendered.route=route.map(row=>({...row}));rendered.confirmed=confirmed;});
  },{context});
  const mod = new vm.SourceTextModule(await readFile(new URL('../js/trips.js', import.meta.url),'utf8'),{context});
  await mod.link(spec=>spec.includes('core.js')?core:deps);await mod.evaluate();
  const state = {customers:[],settings:{},authToken:'fixture',orders:['A','B'].map(id=>({id,orderNumber:`WO-${id}`,downstream:`Fixture ${id}`,address:`Address ${id}`,status:'未完成'}))};
  const render = ()=>mod.namespace.renderTrips(state);
  mod.namespace.bindTripEvents(state,()=>{},render);render();
  const check = (id,checked)=>$('tripOrdersTbody').listeners.change({target:{closest:selector=>selector.startsWith('input')?{checked,dataset:{tripOrderCheck:id}}:null}});
  return {state,requests,alerts,rendered,check,render,click:id=>$(id).listeners.click(),pause:fn=>{pauseOptimize=fn;}};
}

test('changing from A to B invalidates A and only a confirmed B can execute', async () => {
  const h = await harness();h.check('A',true);await h.click('tripOptimizeBtn');
  assert.equal(h.rendered.route[1].id,'A');
  h.check('A',false);h.check('B',true);
  assert.equal(h.rendered.route.length,0);
  await h.click('tripConfirmManualBtn');await h.click('tripExecuteBtn');
  assert.equal(h.requests.length,1);
  await h.click('tripOptimizeBtn');await h.click('tripConfirmManualBtn');await h.click('tripExecuteBtn');
  const confirm = h.requests.find(request=>request.body.preserveOrder);
  const execute = h.requests.find(request=>request.url.endsWith('execute'));
  assert.deepEqual(Array.from(confirm.body.stops,row=>row.id),['B']);
  assert.deepEqual(Array.from(execute.body.orderIds),['B']);
});

test('a late optimization response cannot restore an obsolete selection', async () => {
  const h = await harness();let release;
  h.pause(()=>new Promise(resolve=>{release=resolve;}));h.check('A',true);
  const optimize = h.click('tripOptimizeBtn');
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  h.check('A',false);h.check('B',true);release();await optimize;
  assert.equal(h.rendered.route.length,0);
  await h.click('tripExecuteBtn');
  assert.equal(h.requests.length,1);
});

test('a late route confirmation cannot approve a changed address', async () => {
  const h = await harness();h.check('A',true);await h.click('tripOptimizeBtn');let release;
  h.pause(()=>new Promise(resolve=>{release=resolve;}));
  const confirm = h.click('tripConfirmManualBtn');
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  h.state.orders[0].address='Changed address';h.render();release();await confirm;
  assert.equal(h.rendered.route.length,0);
  await h.click('tripExecuteBtn');
  assert.equal(h.requests.length,2);
});
