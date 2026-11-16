import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(id='') { this.id=id; this.value=''; this.checked=false; this.disabled=false; this.textContent=''; this.listeners={}; this.attributes={}; this.type=''; this.validity={valid:true}; }
  addEventListener(name,fn) { this.listeners[name]=fn; }
  emit(name,target=this) { return this.listeners[name]?.({ currentTarget:this, target, preventDefault() {} }); }
  querySelector() { return this.button; }
  querySelectorAll(selector) { return selector === 'input[type="number"]' ? (this.controls || []).filter(x=>x.type==='number') : (this.controls || [this.button]).filter(Boolean); }
  setAttribute(k,v) { this.attributes[k]=v; } getAttribute(k) { return this.attributes[k]??null; } removeAttribute(k) { delete this.attributes[k]; }
}
async function harness(reply = () => ({ ok:true, json:async()=>({ok:true,settingsVersion:'v1'}) })) {
  const form=new Element('settingsForm'), title=new Element('settingsAppTitle'), access=new Element('settingsOpenAccess');
  form.button=new Element('submit');form.button.textContent='立即儲存';
  const accessBtn=new Element('saveOpenAccessBtn'), resetBtn=new Element('resetSettingsBtn'), autoStatus=new Element('settingsAutoSaveStatus'), accessStatus=new Element('openAccessStatus'), number=new Element('settingsOrderWarningDays'), phone=new Element('settingsCompanyPhone');
  const shortcut=new Element('settingsEnableKeyboardShortcut'), landing=new Element('settingsDefaultLandingView'), color=new Element('settingsThemeAccent');
  number.type='number';shortcut.type='checkbox';color.type='color';form.controls=[form.button,access,accessBtn,resetBtn,number,title,phone,shortcut,landing,color];
  const els={settingsForm:form,settingsAppTitle:title,settingsOpenAccess:access,saveOpenAccessBtn:accessBtn,resetSettingsBtn:resetBtn,settingsAutoSaveStatus:autoStatus,openAccessStatus:accessStatus,settingsOrderWarningDays:number,settingsCompanyPhone:phone,settingsEnableKeyboardShortcut:shortcut,settingsDefaultLandingView:landing,settingsThemeAccent:color};
  const handlers={},documentHandlers={},alerts=[],requests=[],timers=new Map();let now=0,nextTimer=0;
  const document={getElementById:id=>els[id],querySelectorAll:()=>[],addEventListener:(name,fn)=>{documentHandlers[name]=fn;},documentElement:{style:{setProperty(){}}},body:{dataset:{}}};
  const context=vm.createContext({document,window:{addEventListener:(name,fn)=>{handlers[name]=fn;},confirm:()=>false},alert:s=>alerts.push(s),fetch:(url,options)=>{requests.push(JSON.parse(options.body));return reply(url,options);},console,
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{at:now+ms,fn});return id;},clearTimeout:id=>timers.delete(id)});
  const shared=new vm.SourceTextModule(source('shared.js'),{context}),busy=new vm.SourceTextModule(source('busy-action.js'),{context}),settings=new vm.SourceTextModule(source('settings.js'),{context});
  await settings.link(specifier=>specifier.includes('busy-action')?busy:shared);await settings.evaluate();
  const state={settings:shared.namespace.getDefaultSettings(),settingsVersion:'v0',userRole:'admin',authToken:'A'};
  settings.namespace.bindSettingsEvents(state,async()=>{},()=>settings.namespace.renderSettings(state));settings.namespace.renderSettings(state);
  function advance(ms){const end=now+ms;while(true){const e=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!e)break;now=e[1].at;timers.delete(e[0]);e[1].fn();}now=end;}
  return {document,form,title,access,accessBtn,resetBtn,autoStatus,accessStatus,number,phone,shortcut,landing,color,state,settings:settings.namespace,handlers,documentHandlers,alerts,requests,advance};
}

test('background render preserves typed draft and continues to reflect preview',async()=>{
  const h=await harness();h.title.value='新的系統名稱';h.form.emit('input',h.title);h.state.settings.appTitle='背景的設定';h.settings.renderSettings(h.state);assert.equal(h.title.value,'新的系統名稱');
});
test('automatically saves only after two seconds of inactivity',async()=>{
  const h=await harness();h.title.value='新';h.form.emit('input',h.title);h.advance(1500);h.title.value='新的名稱';h.form.emit('input',h.title);h.advance(1999);assert.equal(h.requests.length,0);h.advance(1);await settle();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].settings.appTitle,'新的名稱');assert.equal(h.requests[0].expectedVersion,'v0');assert.equal(h.autoStatus.textContent,'已儲存');
});
test('text change fired on blur after autosave does not send the same value twice',async()=>{
  const h=await harness();h.title.value='編輯完成';h.form.emit('input',h.title);h.advance(2000);await settle();assert.equal(h.requests.length,1);
  h.form.emit('change',h.title);h.advance(3000);await settle();assert.equal(h.requests.length,1);assert.equal(h.autoStatus.textContent,'已儲存');
});
test('checkbox input followed by the same delayed change is not sent twice',async()=>{
  const h=await harness();h.shortcut.checked=false;h.form.emit('input',h.shortcut);h.advance(2000);await settle();assert.equal(h.requests.length,1);
  h.form.emit('change',h.shortcut);h.advance(3000);await settle();assert.equal(h.requests.length,1);
});
test('change-only checkbox, select, and color controls still trigger autosave',async()=>{
  const h=await harness();h.shortcut.checked=false;h.form.emit('change',h.shortcut);h.landing.value='notificationsView';h.form.emit('change',h.landing);h.color.value='#123456';h.form.emit('change',h.color);
  h.advance(2000);await settle();assert.equal(h.requests.length,1);assert.equal(h.requests[0].settings.enableKeyboardShortcut,false);assert.equal(h.requests[0].settings.defaultLandingView,'notificationsView');assert.equal(h.requests[0].settings.themeAccent,'#123456');
});
test('a later change with a different value is saved even if the field had an earlier input event',async()=>{
  let n=0;const h=await harness(()=>({ok:true,json:async()=>({ok:true,settingsVersion:`v${++n}`})}));h.title.value='第一次';h.form.emit('input',h.title);h.advance(2000);await settle();
  h.title.value='第二次';h.form.emit('change',h.title);h.advance(2000);await settle();assert.equal(h.requests.length,2);assert.equal(h.requests[1].settings.appTitle,'第二次');assert.equal(h.requests[1].expectedVersion,'v1');
});
test('edits while a slow save runs stay visible and save serially with its returned version',async()=>{
  let release;const h=await harness(()=>h.requests.length===1?new Promise(resolve=>{release=resolve;}):({ok:true,json:async()=>({ok:true,settingsVersion:'v2'})}));
  h.title.value='第一版';h.form.emit('input',h.title);h.advance(2000);await settle();assert.equal(h.autoStatus.textContent,'儲存中…');
  h.title.value='第二版';h.form.emit('input',h.title);h.advance(2000);await settle();assert.equal(h.requests.length,1);
  release({ok:true,json:async()=>({ok:true,settingsVersion:'v1'})});await settle();await settle();
  assert.equal(h.requests.length,2);assert.equal(h.requests[0].settings.appTitle,'第一版');assert.equal(h.requests[1].settings.appTitle,'第二版');assert.equal(h.requests[1].expectedVersion,'v1');assert.equal(h.title.value,'第二版');assert.equal(h.state.settings.appTitle,'第二版');
});
test('conflict preserves draft and never silently retries even after more edits',async()=>{
  const h=await harness(()=>({ok:false,status:409,json:async()=>({error:'資料已變更',conflict:true})}));const original=h.state.settings.appTitle;
  h.title.value='尚未完成的草稿';h.form.emit('input',h.title);h.advance(2000);await settle();assert.match(h.autoStatus.textContent,/其他人更新/);
  h.title.value='繼續輸入';h.form.emit('input',h.title);h.advance(5000);await settle();await h.form.emit('submit');h.settings.renderSettings(h.state);
  assert.equal(h.requests.length,1);assert.equal(h.title.value,'繼續輸入');assert.equal(h.state.settings.appTitle,original);
});
test('lost response is uncertain and must not be automatically resent',async()=>{
  const h=await harness(()=>Promise.reject(new TypeError('offline')));h.title.value='草稿';h.form.emit('input',h.title);h.advance(2000);await settle();assert.match(h.autoStatus.textContent,/無法確認/);
  h.title.value='新草稿';h.form.emit('input',h.title);h.advance(3000);await settle();await h.form.emit('submit');assert.equal(h.requests.length,1);
});
test('blank or invalid numeric input is kept and never replaced by a default',async()=>{
  const h=await harness();h.number.value='';h.form.emit('input',h.number);h.advance(2000);await settle();assert.equal(h.requests.length,0);assert.match(h.autoStatus.textContent,/填妥/);assert.equal(h.number.value,'');
  h.number.value='5';h.form.emit('input',h.number);h.advance(2000);await settle();assert.equal(h.requests.length,1);assert.equal(h.requests[0].settings.orderWarningDays,5);
});
test('optional company contact can be cleared without replacing it with a default',async()=>{
  const h=await harness();h.phone.value='';h.form.emit('input',h.phone);h.advance(2000);await settle();assert.equal(h.requests.length,1);assert.equal(h.requests[0].settings.companyPhone,'');
});
test('global access change needs explicit confirmation and is excluded from unrelated autosave and reset',async()=>{
  let n=0;const h=await harness(()=>({ok:true,json:async()=>({ok:true,settingsVersion:`v${++n}`})}));
  assert.equal(h.state.settings.openAccess,true);h.access.checked=false;h.form.emit('change',h.access);h.advance(3000);await settle();assert.equal(h.requests.length,0);
  assert.match(h.autoStatus.textContent,/權限變更尚未確認/);
  h.title.value='一般設定';h.form.emit('input',h.title);h.advance(2000);await settle();assert.equal(h.requests[0].settings.openAccess,true);assert.equal(h.access.checked,false);
  assert.match(h.autoStatus.textContent,/權限變更尚未確認/);
  await h.accessBtn.emit('click');assert.equal(h.requests.length,2);assert.equal(h.requests[1].settings.openAccess,false);assert.equal(h.requests[1].expectedVersion,'v1');assert.doesNotMatch(h.autoStatus.textContent,/權限變更尚未確認/);
  await h.resetBtn.emit('click');assert.equal(h.requests.length,3);assert.equal(h.requests[2].settings.openAccess,false);
});
test('logout clears another session’s unsaved draft',async()=>{
  const h=await harness();h.title.value='前一個人的草稿';h.form.emit('input',h.title);h.state.authToken=null;h.handlers['app:auth-changed']();h.state.authToken='B';h.state.settings.appTitle='新登入的設定';h.settings.renderSettings(h.state);assert.equal(h.title.value,'新登入的設定');h.advance(3000);await settle();assert.equal(h.requests.length,0);
});
test('a new account does not inherit the previous account’s input-event deduplication',async()=>{
  const h=await harness();
  h.shortcut.checked=false;h.form.emit('input',h.shortcut);
  h.state.authToken=null;h.handlers['app:auth-changed']();
  h.state.authToken='B';h.state.settings.enableKeyboardShortcut=true;h.settings.renderSettings(h.state);
  h.shortcut.checked=false;h.form.emit('change',h.shortcut);h.advance(2000);await settle();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].settings.enableKeyboardShortcut,false);
});

test('refresh does not rebuild focused settings fields after a successful save',async()=>{
  const h=await harness();h.form.contains=element=>element===h.title;h.title.tagName='INPUT';
  h.title.value='編輯中';h.form.emit('input',h.title);h.advance(2000);await settle();
  h.document.activeElement=h.title;h.state.settings.appTitle='背景更新';h.settings.renderSettings(h.state);
  assert.equal(h.title.value,'編輯中');
});

test('unconfirmed global access stays excluded while a save is in flight',async()=>{
  let release;const h=await harness(()=>h.requests.length===1?new Promise(resolve=>{release=resolve;}):({ok:true,json:async()=>({ok:true,settingsVersion:'v2'})}));
  h.title.value='名稱';h.form.emit('input',h.title);h.advance(2000);await settle();
  h.access.checked=false;h.form.emit('change',h.access);const confirming=h.accessBtn.emit('click');await settle();assert.equal(h.requests.length,1);
  release({ok:true,json:async()=>({ok:true,settingsVersion:'v1'})});await confirming;await settle();
  assert.equal(h.requests.length,2);assert.equal(h.requests[0].settings.openAccess,true);assert.equal(h.requests[1].settings.openAccess,false);assert.equal(h.requests[1].expectedVersion,'v1');
});

test('beforeunload warns and manual logout may be canceled while edits remain',async()=>{
  const h=await harness();h.title.value='未儲存';h.form.emit('input',h.title);let prevented=false;const e={preventDefault(){prevented=true;},returnValue:null};h.handlers.beforeunload(e);assert.equal(prevented,true);
  let stopped=false;h.documentHandlers.click({isTrusted:true,target:{closest:()=>({})},preventDefault(){},stopImmediatePropagation(){stopped=true;}});assert.equal(stopped,true);
});
