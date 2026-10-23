// Collaboration presence is advisory; it never changes orders or blocks edits.
export const PRESENCE_FIELDS = {
  orderNumber:'工單編號',orderDate:'交貨日期',billingCustomerInput:'客人',upstreamInput:'上游',
  downstreamInput:'下游',orderAddress:'送貨地址',orderItemName:'品名',sheetCountText:'數量說明',
  sheetCount:'張數',sizeNotation:'尺寸',sizeLength:'天',sizeWidth:'地',sizeUnit:'單位',
  machineType:'尺寸級距',glossType:'上光',totalPrice:'總價',orderStatus:'狀態',
};

export function capturePresenceCursor(target, point) {
  const field=target.closest('input[id],select[id]');
  const row=target.closest('tr[data-edit]');
  const anchor=field && PRESENCE_FIELDS[field.id] ? field : row;
  if (!anchor) return null;
  const rect=anchor.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {kind:anchor===field?'field':'row',id:anchor===field?field.id:row.dataset.edit,
    x:Math.min(1,Math.max(0,(point.clientX-rect.left)/rect.width)),
    y:Math.min(1,Math.max(0,(point.clientY-rect.top)/rect.height))};
}

export function findPresenceAnchor(doc, peer, formOrderId, isForm) {
  if (!peer.cursor) return null;
  if (peer.cursor.kind==='field') {
    if (!isForm || !formOrderId || peer.orderId!==formOrderId) return null;
    return doc.getElementById(peer.cursor.id);
  }
  if (isForm) return null;
  return [...doc.querySelectorAll('tr[data-edit]')].find(row=>row.dataset.edit===peer.cursor.id) || null;
}

export function initializePresence({state,getView}) {
  const clientId=crypto.randomUUID();
  let cursor=null,peers=[],timer,busy=false,wasActive=false,generation=0,stopped=false,connected=false;
  let lastBanner=null,lastBannerText='';
  const marked=new Set();
  const layer=document.createElement('div');
  layer.className='presence-cursor-layer';layer.setAttribute('aria-hidden','true');document.body.append(layer);
  const isForm=()=>state.orderScreen==='form';
  const currentOrderId=()=>isForm()?(document.getElementById('orderId')?.value || ''):'';
  function clearMarkers() {
    layer.replaceChildren();
    for(const element of marked){element.classList.remove('presence-active-target');element.style.removeProperty('--presence-color');}
    marked.clear();
  }
  function identity(peer){return `${peer.name} · ${peer.clientId.slice(-4)}`;}
  function activity(peer){
    if(peer.moving)return `移動 ${peer.orderNumber || '工單'}`;
    if(peer.editing)return `${peer.orderNumber?`編輯 ${peer.orderNumber}`:'新增工單'}${peer.fieldLabel?`／${peer.fieldLabel}`:''}`;
    return peer.orderNumber?`查看 ${peer.orderNumber}`:'查看工單列表';
  }
  function paint() {
    clearMarkers();
    const banner=document.getElementById('orderPresence');
    const active=getView()==='ordersView' && !!state.authToken && !document.hidden;
    const bannerText=JSON.stringify([active,connected,state.user,peers.map(peer=>[identity(peer),activity(peer),peer.color])]);
    if(banner && (banner!==lastBanner || bannerText!==lastBannerText)){
      lastBanner=banner;lastBannerText=bannerText;
      banner.replaceChildren();banner.hidden=!active;
      if(active){
        const status=document.createElement('span');
        status.className='presence-summary';
        status.textContent=connected?`協作在線 ${peers.length+1} 人｜你：${state.user || '使用者'} · ${clientId.slice(-4)}`:'協作連線中／暫時離線';
        banner.append(status);
        for(const peer of peers){
          const label=document.createElement('span');label.className='presence-person';
          label.style.setProperty('--presence-color',peer.color);
          label.textContent=`${identity(peer)}：${activity(peer)}`;banner.append(label);
        }
      }
    }
    if(!active)return;
    for(const peer of peers){
      const element=findPresenceAnchor(document,peer,currentOrderId(),isForm());
      if(!element || !element.isConnected)continue;
      const rect=element.getBoundingClientRect();
      if(!rect.width || !rect.height || rect.bottom<0 || rect.top>innerHeight)continue;
      element.classList.add('presence-active-target');element.style.setProperty('--presence-color',peer.color);marked.add(element);
      const pointer=document.createElement('div');pointer.className='presence-cursor';
      pointer.style.setProperty('--presence-color',peer.color);
      pointer.style.left=`${Math.min(innerWidth-8,Math.max(0,rect.left+rect.width*peer.cursor.x))}px`;
      pointer.style.top=`${Math.min(innerHeight-8,Math.max(0,rect.top+rect.height*peer.cursor.y))}px`;
      const arrow=document.createElement('span');arrow.className='presence-arrow';
      const name=document.createElement('span');name.className='presence-cursor-name';name.textContent=identity(peer);
      pointer.append(arrow,name);layer.append(pointer);
    }
  }
  async function heartbeat() {
    const active=getView()==='ordersView' && !!state.authToken && !document.hidden;
    if(!active){peers=[];paint();}
    if(busy || stopped)return;
    if(!active && !wasActive){peers=[];paint();return;}
    const token=state.authToken,version=generation;
    if(!token){wasActive=false;peers=[];paint();return;}
    busy=true;wasActive=active;
    const focused=document.activeElement;
    const field=active && isForm() && PRESENCE_FIELDS[focused?.id] ? focused.id:'';
    let orderId=currentOrderId();
    let number=isForm()?(document.getElementById('orderNumber')?.value || ''):'';
    const dragging=document.querySelector?.('tr.is-drag-placeholder');
    if(!isForm() && cursor?.kind==='row'){
      const row=state.orders.find(row=>row.id===cursor.id);orderId=row?.id || '';number=row?.orderNumber || '';
    }
    if(dragging){const row=state.orders.find(row=>row.id===dragging.dataset.edit);orderId=row?.id || '';number=row?.orderNumber || '';}
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch('/api/presence',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({clientId,active,orderId,orderNumber:number,field,editing:active && isForm(),moving:!!dragging,cursor:active?cursor:null}),signal:controller.signal,
      });
      if(!response.ok)throw new Error('presence unavailable');
      const data=await response.json();
      if(version!==generation || state.authToken!==token || !active || getView()!=='ordersView' || document.hidden)return;
      peers=(data.peers || []).filter(peer=>data.serverTime-peer.updatedAt<data.ttlMs);
      connected=true;paint();
    }catch{
      if(version===generation){peers=[];connected=false;paint();}
    }finally{clearTimeout(timeout);busy=false;}
  }
  function sample(event) {
    if(getView()!=='ordersView')return;
    const point=event.touches?.[0] || event;
    const target=event.touches ? document.elementFromPoint?.(point.clientX,point.clientY) || event.target : event.target;
    const next=capturePresenceCursor(target,point);
    if(next)cursor=next;
  }
  document.addEventListener('pointermove',sample,{passive:true});
  document.addEventListener('touchstart',sample,{passive:true});
  document.addEventListener('touchmove',sample,{passive:true});
  document.addEventListener('focusin',event=>{
    cursor=null;
    if(PRESENCE_FIELDS[event.target.id]){
      const rect=event.target.getBoundingClientRect();
      cursor=capturePresenceCursor(event.target,{clientX:rect.left+8,clientY:rect.top+rect.height/2});
    }
    void heartbeat();
  });
  document.addEventListener('scroll',paint,{passive:true,capture:true});
  window.addEventListener('resize',paint);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){peers=[];paint();}void heartbeat();});
  window.addEventListener('app:auth-changed',()=>{generation++;peers=[];connected=false;wasActive=false;cursor=null;paint();});
  function loop(){if(stopped)return;void heartbeat();timer=setTimeout(loop,1000);}
  loop();
  return ()=>{stopped=true;clearTimeout(timer);peers=[];clearMarkers();layer.remove();};
}
