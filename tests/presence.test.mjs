import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../js/presence.js',import.meta.url),'utf8');
async function module(context={}){
  const mod=new vm.SourceTextModule(source,{context:vm.createContext({console,...context})});
  await mod.link(()=>{throw Error('Unexpected import');});await mod.evaluate();return mod.namespace;
}
test('cursor coordinates are relative to supported fields and clamp within bounds',async()=>{
  const mod=await module();
  const field={id:'sheetCount',getBoundingClientRect:()=>({left:20,top:10,width:200,height:40})};
  const target={closest:selector=>selector==='input[id],select[id]'?field:null};
  const result=mod.capturePresenceCursor(target,{clientX:120,clientY:30});
  assert.deepEqual({...result},{kind:'field',id:'sheetCount',x:.5,y:.5});
  assert.equal(mod.capturePresenceCursor(target,{clientX:500,clientY:-20}).x,1);
  field.id='password';assert.equal(mod.capturePresenceCursor(target,{clientX:120,clientY:30}),null);
});
test('peer cursor does not appear over a different order or another unsaved draft',async()=>{
  const mod=await module(),field={id:'sheetCount'},row={dataset:{edit:'o2'}};
  const doc={getElementById:()=>field,querySelectorAll:()=>[row]};
  const peer={orderId:'o1',cursor:{kind:'field',id:'sheetCount'}};
  assert.equal(mod.findPresenceAnchor(doc,peer,'o1',true),field);
  assert.equal(mod.findPresenceAnchor(doc,peer,'o2',true),null);
  assert.equal(mod.findPresenceAnchor(doc,{...peer,orderId:''},'',true),null);
  assert.equal(mod.findPresenceAnchor(doc,{cursor:{kind:'row',id:'o2'}},'',false),row);
});

function domHarness(fetch){
  class Element{
    children=[];listeners=new Map();isConnected=true;value='';hidden=false;
    classList={add(){},remove(){}};style={setProperty(){},removeProperty(){}};
    addEventListener(name,fn){const list=this.listeners.get(name)||[];list.push(fn);this.listeners.set(name,list);}
    emit(name,event={}){for(const fn of this.listeners.get(name)||[])fn(event);}
    append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}
    setAttribute(){}remove(){this.isConnected=false;}
    getBoundingClientRect(){return {left:10,top:10,width:200,height:40,bottom:50};}
  }
  const elements=new Map(['orderPresence','orderId','orderNumber','sheetCount'].map(id=>[id,Object.assign(new Element(),{id})]));
  elements.get('orderId').value='o1';elements.get('orderNumber').value='WO1';
  const document=new Element();document.body=new Element();document.hidden=false;
  document.createElement=()=>new Element();document.getElementById=id=>elements.get(id);document.querySelectorAll=()=>[];
  document.activeElement=elements.get('sheetCount');const window=new Element();
  let view='ordersView';const state={authToken:'A',user:'User A',orderScreen:'form',orders:[{id:'o1',orderNumber:'WO1'}]};
  return {document,window,state,elements,view:()=>view,setView:value=>{view=value;},
    context:{document,window,fetch,crypto:{randomUUID:()=> 'client-1111'},setTimeout:()=>1,clearTimeout(){},AbortController,innerWidth:1000,innerHeight:800}};
}
const peer={id:'second',name:'User B',clientId:'client-2222',color:'#60a5fa',orderId:'o1',orderNumber:'WO1',fieldLabel:'張數',editing:true,cursor:{kind:'field',id:'sheetCount',x:.5,y:.5},updatedAt:100};
const reply=()=>({ok:true,json:async()=>({peers:[peer],serverTime:100,ttlMs:15000})});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('a connected peer appears as a named cursor; hiding the tab clears markers',async()=>{
  const requests=[];const h=domHarness(async(url,options)=>{requests.push(JSON.parse(options.body));return reply();});
  const mod=await module(h.context);const stop=mod.initializePresence({state:h.state,getView:h.view});await settle();
  const layer=h.document.body.children[0];assert.equal(layer.children.length,1);
  assert.equal(layer.children[0].children[1].textContent,'User B · 2222');
  assert.equal(requests[0].field,'sheetCount');assert.equal(requests[0].editing,true);
  h.document.hidden=true;h.document.emit('visibilitychange');assert.equal(layer.children.length,0);stop();
});
test('presence failures do not change or block order data',async()=>{
  const h=domHarness(async()=>{throw Error('offline');});const before=JSON.stringify(h.state.orders);
  const mod=await module(h.context);const stop=mod.initializePresence({state:h.state,getView:h.view});await settle();
  assert.equal(JSON.stringify(h.state.orders),before);assert.equal(h.document.body.children[0].children.length,0);stop();
});
test('a response from a logged-out account cannot display previous peers',async()=>{
  let release;const h=domHarness(async()=>{await new Promise(resolve=>{release=resolve;});return reply();});
  const mod=await module(h.context);const stop=mod.initializePresence({state:h.state,getView:h.view});
  h.state.authToken='B';h.window.emit('app:auth-changed');release();await settle();
  assert.equal(h.document.body.children[0].children.length,0);stop();
});
test('no presence is sent while outside the orders module',async()=>{
  let calls=0;const h=domHarness(async()=>{calls++;return reply();});h.setView('dashboardView');
  const mod=await module(h.context);const stop=mod.initializePresence({state:h.state,getView:h.view});await settle();
  assert.equal(calls,0);stop();
});
