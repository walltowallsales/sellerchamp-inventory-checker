const $=id=>document.getElementById(id);
let currentProduct=null,pendingQtyLocationIndex=null,lastShelf='';
const state={pin:localStorage.getItem('sc_pin')||''};

function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(msg,type=''){const t=$('toast');t.textContent=msg;t.className='toast '+type;t.classList.remove('hidden');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.add('hidden'),3500);}
function busy(btn,on,label){if(!btn)return; if(on){btn.dataset.old=btn.textContent;btn.textContent=label;btn.disabled=true}else{btn.textContent=btn.dataset.old||btn.textContent;btn.disabled=false}}
async function api(url,opts={}){opts.cache='no-store';opts.headers={...(opts.headers||{}),'Content-Type':'application/json','Cache-Control':'no-cache'};if(state.pin)opts.headers['X-App-Pin']=state.pin;const r=await fetch(url,opts);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||d.details||`HTTP ${r.status}`);return d;}

async function checkStatus(){try{const d=await api('/api/status?fresh='+Date.now());$('connection').textContent='SellerChamp connected';$('connection').className='status ok';$('appVersion').textContent='v'+(d.version||'1.2.0');$('pinCard').classList.add('hidden')}catch(e){$('connection').textContent=e.message.includes('PIN')?'PIN required':'Not connected';$('connection').className='status bad';if(e.message.includes('PIN'))$('pinCard').classList.remove('hidden')}}
$('savePin').onclick=()=>{state.pin=$('pin').value.trim();localStorage.setItem('sc_pin',state.pin);checkStatus()};

function showPanel(which){
 const shelf=which==='shelf'; $('shelfPanel').classList.toggle('hidden',!shelf);$('itemPanel').classList.toggle('hidden',shelf);
 $('shelfTab').classList.toggle('active',shelf);$('itemTab').classList.toggle('active',!shelf);
 requestAnimationFrame(()=>$(shelf?'shelfLookup':'lookup').focus());
}
$('shelfTab').onclick=()=>showPanel('shelf');$('itemTab').onclick=()=>showPanel('item');

async function checkShelf(){
 const location=$('shelfLookup').value.trim();if(!location)return toast('Scan or enter a shelf location.','error');
 lastShelf=location;busy($('shelfBtn'),true,'Checking…');
 try{const d=await api(`/api/shelf-report?location=${encodeURIComponent(location)}`);renderShelf(d)}
 catch(e){toast(e.message,'error')}finally{busy($('shelfBtn'),false)}
}
$('shelfBtn').onclick=checkShelf;$('shelfLookup').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();checkShelf()}});
$('refreshShelf').onclick=()=>{if(lastShelf){$('shelfLookup').value=lastShelf;checkShelf()}};

function renderShelf(d){
 $('shelfReport').classList.remove('hidden');$('shelfName').textContent=d.location;
 const warnings=Array.isArray(d.warnings)?d.warnings:[],warningBox=$('shelfWarnings');
 warningBox.classList.toggle('hidden',!warnings.length);
 warningBox.innerHTML=warnings.map(x=>`<div>${escapeHtml(x)}</div>`).join('');
 $('shelfStats').innerHTML=`<div><strong>${d.items.length}</strong><span>records</span></div><div><strong>${d.expected_quantity}</strong><span>expected qty</span></div><div><strong>${d.not_submitted_count}</strong><span>not submitted</span></div>`;
 const box=$('shelfItems');
 if(!d.items.length){box.innerHTML='<div class="location-empty">No SellerChamp inventory was found for this shelf.</div>';return}
 box.innerHTML=d.items.map((x,i)=>`<button class="shelf-item" data-index="${i}">
   ${x.image?`<img src="${escapeHtml(x.image)}" alt="">`:''}
   <span class="shelf-item-main"><span class="shelf-sku">${escapeHtml(x.sku||'No SKU')}</span><span class="shelf-title">${escapeHtml(x.title||'Untitled item')}</span>
   <span class="shelf-meta">Qty ${Number(x.quantity||0)}${Number(x.reserve_quantity||0)?` • Reserve ${Number(x.reserve_quantity)}`:''}</span></span>
   ${x.submitted?'<span class="badge submitted">SUBMITTED</span>':'<span class="badge not-submitted">NOT SUBMITTED</span>'}
 </button>`).join('');
 box.querySelectorAll('.shelf-item').forEach(btn=>btn.onclick=()=>{
   const x=d.items[Number(btn.dataset.index)];showPanel('item');$('lookup').value=x.sku||'';findItem();
 });
}

async function findItem(){
 const code=$('lookup').value.trim();if(!code)return toast('Scan or enter an item.','error');busy($('findBtn'),true,'Finding…');
 try{const d=await api(`/api/lookup?code=${encodeURIComponent(code)}`);currentProduct=d.product;showProduct()}
 catch(e){currentProduct=null;$('productCard').classList.add('hidden');toast(e.message,'error')}finally{busy($('findBtn'),false)}
}
$('findBtn').onclick=findItem;$('lookup').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();findItem()}});

function showProduct(){
 const p=currentProduct,isBatch=p.workflow==='batch';$('productCard').classList.remove('hidden');
 const sku=p.sku||p.catalogue_sku||p.upc||'';$('sku').textContent='SKU '+sku;$('title').textContent=p.title||'Untitled item';
 $('itemStatus').innerHTML=isBatch?'<span class="badge not-submitted">NOT SUBMITTED</span>':'<span class="badge submitted">SUBMITTED / PRODUCTS</span>';
 if(p.image){$('productImage').src=p.image;$('productImage').classList.remove('hidden')}else $('productImage').classList.add('hidden');
 $('openProductBtn').dataset.url=sku?`https://app2.sellerchamp.com/products?product%5Bquery%5D=${encodeURIComponent(sku)}`:'';
 $('openProductBtn').disabled=!sku;$('openBatchBtn').dataset.url=p.sellerchamp_batch_url||'';$('openBatchBtn').disabled=!p.sellerchamp_batch_url;
 const locations=Array.isArray(p.locations)?p.locations:[],all=$('allLocations');
 all.innerHTML=locations.length?locations.map((l,i)=>{
   const qty=Number(l.quantity_available||0);
   const action=isBatch?`<button class="batch-edit" data-i="${i}">EDIT IN SELLERCHAMP BATCH</button>`:(l.id?`<button class="update-qty" data-i="${i}">Update Qty</button>`:'');
   return `<div class="location-row"><span class="location-name">${escapeHtml(l.location||'—')}</span><span class="location-actions"><span class="location-qty">Qty ${qty}</span>${action}</span></div>`;
 }).join(''):'<div class="location-empty">No inventory locations found.</div>';
 all.querySelectorAll('.update-qty').forEach(b=>b.onclick=()=>openQtyModal(Number(b.dataset.i)));
 all.querySelectorAll('.batch-edit').forEach(b=>b.onclick=openBatch);
 $('productActions').classList.toggle('hidden',isBatch);
 const sel=$('fromLocation');sel.innerHTML='';locations.forEach((l,i)=>sel.add(new Option(`${l.location} — Qty ${l.quantity_available}`,String(i))));
 sel.value=locations.length?'0':'';updateSourceQty();$('toLocation').value='';$('moveAll').checked=true;$('partialQtyWrap').classList.add('hidden');
 if(isBatch)toast('Not submitted. Use SellerChamp Batch to change quantity or location.');
 else requestAnimationFrame(()=>$('toLocation').focus());
}
$('openProductBtn').onclick=()=>{const u=$('openProductBtn').dataset.url;if(u)window.open(u,'_blank','noopener')};
function openBatch(){const u=$('openBatchBtn').dataset.url;if(!u)return toast('Batch link unavailable.','error');const sku=currentProduct?.sku||'';try{if(sku&&navigator.clipboard)navigator.clipboard.writeText(sku)}catch{}window.open(u,'_blank','noopener')}
$('openBatchBtn').onclick=openBatch;

function selectedLocation(){if(!currentProduct)return null;const i=Number($('fromLocation').value);return Number.isInteger(i)?currentProduct.locations[i]:null}
function updateSourceQty(){const l=selectedLocation();$('sourceQty').textContent=l?`Available at this location: ${l.quantity_available}`:'';$('moveQty').max=l?.quantity_available||1}
$('fromLocation').onchange=updateSourceQty;$('moveAll').onchange=()=>$('partialQtyWrap').classList.toggle('hidden',$('moveAll').checked);

async function moveItem(){
 if(!currentProduct||currentProduct.workflow==='batch')return openBatch();
 const from=selectedLocation(),to=$('toLocation').value.trim();if(!from||!to)return toast('Choose a source and scan the new location.','error');
 const all=$('moveAll').checked,qty=all?Number(from.quantity_available||0):Number($('moveQty').value||0);
 if(!qty||qty<1)return toast('Enter a quantity to move.','error');
 busy($('moveBtn'),true,'Moving…');
 try{await api('/api/move',{method:'POST',body:JSON.stringify({mode:currentProduct.mode,productId:currentProduct.id,fromLocation:from.location,toLocation:to,quantity:qty,allQuantity:all,sourceLocationId:from.id,sku:currentProduct.sku||currentProduct.catalogue_sku||'',title:currentProduct.title||''})});
 $('confirmText').innerHTML=`<strong>${escapeHtml(currentProduct.sku||'')}</strong><br>${escapeHtml(from.location)} → ${escapeHtml(to)}<br>Quantity moved: <strong>${qty}</strong>`;$('moveConfirm').classList.remove('hidden')
 }catch(e){toast(e.message,'error')}finally{busy($('moveBtn'),false)}
}
$('moveBtn').onclick=moveItem;$('confirmOk').onclick=()=>{$('moveConfirm').classList.add('hidden');clearItem()};

function openQtyModal(index){const l=currentProduct?.locations?.[index];if(!l?.id)return;pendingQtyLocationIndex=index;$('qtyModalLocation').textContent=`${l.location} — Current quantity: ${Number(l.quantity_available||0)}`;$('qtyModalInput').value=String(Number(l.quantity_available||0));$('qtyModal').classList.remove('hidden');requestAnimationFrame(()=>{$('qtyModalInput').focus();$('qtyModalInput').select()})}
function closeQtyModal(){$('qtyModal').classList.add('hidden');pendingQtyLocationIndex=null}
$('qtyModalCancel').onclick=closeQtyModal;
$('qtyModalSave').onclick=async()=>{const i=pendingQtyLocationIndex,l=currentProduct?.locations?.[i];if(!l)return;const q=Number($('qtyModalInput').value);if(!Number.isInteger(q)||q<0)return toast('Enter a whole number of 0 or greater.','error');busy($('qtyModalSave'),true,'Updating…');try{await api('/api/update-location-quantity',{method:'POST',body:JSON.stringify({mode:currentProduct.mode,productId:currentProduct.id,locationId:l.id,location:l.location,newQuantity:q,sku:currentProduct.sku||'',title:currentProduct.title||''})});closeQtyModal();toast('Quantity updated.','success');await findItem()}catch(e){toast(e.message,'error')}finally{busy($('qtyModalSave'),false)}};
$('qtyModalInput').addEventListener('keydown',e=>{if(e.key==='Enter'){$('qtyModalSave').click()}});

function clearItem(){currentProduct=null;$('productCard').classList.add('hidden');$('lookup').value='';requestAnimationFrame(()=>$('lookup').focus())}
$('clearBtn').onclick=clearItem;
checkStatus();requestAnimationFrame(()=>$('shelfLookup').focus());
