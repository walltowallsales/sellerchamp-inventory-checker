'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '1.5.0';
const TOKEN = process.env.SELLERCHAMP_TOKEN || '';
const APP_PIN = process.env.APP_PIN || '';
const SC_BASE = 'https://app.sellerchamp.com';

app.use(express.json({ limit: '200kb' }));
app.use((req,res,next)=>{
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  next();
});
app.use(express.static(path.join(__dirname, 'public'),{etag:false,maxAge:0}));

function assertConfigured(req, res, next) {
  if (!TOKEN) return res.status(503).json({ error: 'SELLERCHAMP_TOKEN is not configured on the server.' });
  next();
}

function checkPin(req, res, next) {
  if (!APP_PIN) return next();
  const pin = req.get('x-app-pin') || '';
  if (pin !== APP_PIN) return res.status(401).json({ error: 'Incorrect app PIN.' });
  next();
}

app.use('/api', assertConfigured, checkPin);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let scRequestGate = Promise.resolve();
let lastScRequestAt = 0;

async function scFetch(endpoint, options = {}) {
  // SellerChamp rate-limits rapid inventory requests. Serialize calls and keep
  // them at least 1.1 seconds apart so a shelf scan does not flood the API.
  const previous = scRequestGate;
  let releaseGate;
  scRequestGate = new Promise(resolve => { releaseGate = resolve; });
  await previous;

  try {
    for (let attempt = 0; attempt <= 4; attempt++) {
      const spacing = Math.max(0, 1100 - (Date.now() - lastScRequestAt));
      if (spacing) await wait(spacing);

      const response = await fetch(`${SC_BASE}${endpoint}`, {
        ...options,
        headers: {
          'Token': TOKEN,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      lastScRequestAt = Date.now();

      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

      if (response.status === 429 && attempt < 4) {
        const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
        await wait(Math.max(retryAfter, 2500 * (attempt + 1)));
        continue;
      }
      if (!response.ok) {
        const err = new Error(`SellerChamp returned ${response.status}`);
        err.status = response.status;
        err.data = data;
        throw err;
      }
      return data;
    }
  } finally {
    releaseGate();
  }
}

const CHANGE_LOG_URL = 'https://script.google.com/macros/s/AKfycbw2UHYXOzZajklEXvHf-o5Ht1f6P6e4ifmzWVsRdbyUnVisv-23SUxRrlVr6QMgJk5ZpA/exec';
async function logChange(entry) {
  try {
    const response = await fetch(CHANGE_LOG_URL, {
      method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify(entry), redirect:'follow'
    });
    const text=await response.text(); let data={};
    try{data=JSON.parse(text)}catch{}
    if(!response.ok || data.success===false) return {logged:false,warning:data.error||`HTTP ${response.status}`};
    return {logged:true};
  } catch(e) { return {logged:false,warning:e.message||'Google Sheets logging failed'}; }
}

function normalizeMasterProduct(p) {
  return {
    mode: 'catalog',
    id: p.id,
    sku: p.catalogue_sku || '',
    catalogue_sku: p.catalogue_sku || '',
    upc: p.upc || '',
    asin: p.asin || '',
    title: p.title || '',
    image: p.primary_image || p.primary_image_url || p.image_url || p.image ||
      p.images?.[0]?.large_url || p.images?.[0]?.image_url || p.images?.[0]?.url || '',
    quantity_available: Number(p.quantity_available || 0),
    item_remarks: p.item_remarks || '',
    ebay_item_condition_id: p.ebay_item_condition_id ?? null,
    notes_product_id: p.id,
    locations: (p.inventory_locations || []).map(x => ({
      id: x.id || '',
      location: x.location || '',
      quantity_available: Number(x.quantity_available || 0)
    }))
  };
}

function normalizeLegacyProduct(p) {
  return {
    mode: 'legacy',
    id: p.id,
    sku: p.sku || '',
    catalogue_sku: p.custom_catalogue_sku || p.catalog_sku || '',
    upc: p.upc || '',
    asin: p.asin || '',
    title: p.title || '',
    item_location: p.item_location || '',
    image: p.primary_image || p.primary_image_url || p.image_url || p.image ||
      p.product_images?.[0]?.large_image_url || p.product_images?.[0]?.original_image_url ||
      p.product_images?.[0]?.image_url || p.product_images?.[0]?.url || '',
    quantity_available: Number(p.quantity_available || 0),
    quantity_listed: Number(p.quantity_listed || 0),
    marketplace_id: p.marketplace_id || '',
    list_status: p.list_status || '',
    item_remarks: p.item_remarks || '',
    ebay_item_condition_id: p.ebay_item_condition_id ?? null,
    notes_product_id: p.id,
    sellerchamp_product_url: `https://app.sellerchamp.com/products?sku=${encodeURIComponent(p.sku || p.custom_catalogue_sku || p.upc || '')}`,
    sellerchamp_batch_url: p.manifest_id ? `https://app.sellerchamp.com/manifests/${encodeURIComponent(p.manifest_id)}` : `https://app.sellerchamp.com/manifests`,
    locations: (p.inventory_locations || []).map(x => ({
      id: x.id || '',
      location: x.location || '',
      quantity_available: Number(x.quantity_available || 0),
      priority: Number(x.priority || 1),
      delete_if_empty: x.delete_if_empty !== false
    }))
  };
}

async function getLegacyProductForNotes(code) {
  const product = await lookupLegacy(code);
  return product ? {
    id: product.id,
    item_remarks: product.item_remarks || ''
  } : null;
}

function discoverNotesField(product) {
  if (!product || typeof product !== 'object') return null;

  // SellerChamp's public docs do not document the listing-card "Notes" field.
  // Prefer likely internal field names, then fall back to any top-level string
  // field whose key contains "note" (excluding item_remarks, which is a
  // different condition/remarks field).
  const preferred = [
    'notes',
    'product_notes',
    'internal_notes',
    'item_notes',
    'listing_notes',
    'seller_notes',
    'private_notes'
  ];

  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(product, key) && typeof product[key] === 'string') {
      return { field: key, value: product[key] };
    }
  }

  for (const [key, value] of Object.entries(product)) {
    if (key === 'item_remarks') continue;
    if (/note/i.test(key) && typeof value === 'string') return { field: key, value };
  }
  return null;
}

async function prependPreviousLocation(notesProductId, oldLocation) {
  if (!notesProductId) {
    return { updated: false, verified: false, warning: 'No standard SellerChamp listing was found for updating Notes.' };
  }

  // Read the live product first so the existing Notes text is never overwritten.
  const detail = await scFetch(`/api/products/${encodeURIComponent(notesProductId)}.json`);
  const product = detail.product || detail || {};
  const discovered = discoverNotesField(product);

  if (!discovered) {
    return {
      updated: false,
      verified: false,
      warning: 'SellerChamp did not expose the listing-card Notes field in this product API response. The location was moved, but Notes were left unchanged.',
      visible_note_fields: Object.keys(product).filter(k => /note|remark/i.test(k))
    };
  }

  const notesField = discovered.field;
  const currentNotes = discovered.value || '';
  const prefix = `Previously on ${String(oldLocation).trim()} - `;
  const newNotes = currentNotes.startsWith(prefix) ? currentNotes : prefix + currentNotes;

  await scFetch(`/api/products/${encodeURIComponent(notesProductId)}.json`, {
    method: 'PUT',
    body: JSON.stringify({ product: { [notesField]: newNotes } })
  });

  // Verify by rereading the product and rediscovering the Notes field.
  let verify = await scFetch(`/api/products/${encodeURIComponent(notesProductId)}.json`);
  let verifiedProduct = verify.product || verify || {};
  let verified = discoverNotesField(verifiedProduct);
  if (verified && verified.field === notesField && String(verified.value || '') === newNotes) {
    return { updated: true, verified: true, method: 'product_put', notes_field: notesField, notes: newNotes };
  }

  // Retry via bulk update. SellerChamp may accept more product attributes there
  // than are explicitly documented in the single-product endpoint.
  await scFetch('/api/products/bulk_update.json', {
    method: 'PUT',
    body: JSON.stringify({ products: [{ id: notesProductId, [notesField]: newNotes }] })
  });

  verify = await scFetch(`/api/products/${encodeURIComponent(notesProductId)}.json`);
  verifiedProduct = verify.product || verify || {};
  verified = discoverNotesField(verifiedProduct);
  if (verified && verified.field === notesField && String(verified.value || '') === newNotes) {
    return { updated: true, verified: true, method: 'bulk_update', notes_field: notesField, notes: newNotes };
  }

  return {
    updated: false,
    verified: false,
    notes_field: notesField,
    warning: `SellerChamp exposed the Notes field as “${notesField}”, but did not persist the Notes update through the public product API. The location move still succeeded.`,
    expected: newNotes,
    actual: verified && verified.field === notesField ? String(verified.value || '') : null
  };
}

async function lookupCatalog(code) {
  const attempts = [
    `/api/master_products?catalogue_sku=${encodeURIComponent(code)}&page=1&page_size=25`,
    `/api/master_products?upc=${encodeURIComponent(code)}&page=1&page_size=25`,
    `/api/master_products?asin=${encodeURIComponent(code)}&page=1&page_size=25`
  ];
  for (const endpoint of attempts) {
    try {
      const data = await scFetch(endpoint);
      const items = data.master_products || [];
      if (items.length) {
        const exact = items.find(p =>
          [p.catalogue_sku, p.upc, p.asin].filter(Boolean).some(v => String(v).toLowerCase() === code.toLowerCase())
        );
        return normalizeMasterProduct(exact || items[0]);
      }
    } catch (e) {
      // Catalog Sync disabled is a normal fallback case.
      if (![400, 404, 422].includes(e.status)) throw e;
    }
  }
  return null;
}

async function lookupLegacy(code) {
  const attempts = [
    `/api/products.json?sku=${encodeURIComponent(code)}&page=1&page_size=25`,
    `/api/products.json?upc=${encodeURIComponent(code)}&page=1&page_size=25`,
    `/api/products.json?asin=${encodeURIComponent(code)}&page=1&page_size=25`
  ];
  for (const endpoint of attempts) {
    try {
      const data = await scFetch(endpoint);
      const items = data.products || [];
      if (items.length) {
        const exact = items.find(p => [p.sku, p.upc, p.asin].filter(Boolean).some(v => String(v).toLowerCase() === code.toLowerCase()));
        let p = exact || items[0];
        // Fetch full product detail when available so title/photo fields are complete.
        try {
          const detail = await scFetch(`/api/products/${encodeURIComponent(p.id)}.json`);
          const full = detail.product || detail || {};
          p = { ...p, ...full };
        } catch {}
        // Get authoritative location list because list/detail responses may omit/lag it.
        try {
          const locData = await scFetch(`/api/products/${encodeURIComponent(p.id)}/inventory_locations`);
          p.inventory_locations = locData.inventory_locations || p.inventory_locations || [];
        } catch {}
        return normalizeLegacyProduct(p);
      }
    } catch (e) {
      if (![400, 404].includes(e.status)) throw e;
    }
  }
  return null;
}


async function findManifestForCode(code) {
  const needle = String(code || '').trim().toLowerCase();
  if (!needle) return null;

  // Marketplace Batches are SellerChamp Manifests. Search manifests newest-first,
  // then inspect each manifest's documented product_listings endpoint.
  const pageSize = 100;
  for (let page = 1; page <= 10; page++) {
    let data;
    try {
      data = await scFetch(`/api/manifests?page=${page}&page_size=${pageSize}`);
    } catch (e) {
      if ([400,404].includes(e.status)) return null;
      throw e;
    }
    let list = data.manifests || data.manifest || [];
    if (!Array.isArray(list)) list = list ? [list] : [];
    if (!list.length) break;

    for (const manifest of list) {
      if (!manifest?.id) continue;
      for (let lp = 1; lp <= 20; lp++) {
        let listingData;
        try {
          listingData = await scFetch(`/api/manifests/${encodeURIComponent(manifest.id)}/product_listings?page=${lp}&page_size=100`);
        } catch (e) {
          if ([400,404].includes(e.status)) break;
          throw e;
        }
        let rows = listingData.product_listings || listingData.product_listing || [];
        if (!Array.isArray(rows)) rows = rows ? [rows] : [];
        const matches = rows.filter(x => [
          x.sku, x.alt_sku, x.upc, x.barcode, x.asin,
          x.catalogue_sku, x.custom_catalogue_sku
        ].filter(Boolean).some(v => String(v).trim().toLowerCase() === needle));
        // SellerChamp's product_listing response exposes quantity_listed.
        // A positive quantity_listed is our strongest documented signal that
        // this Batch listing was submitted. Prefer it over draft/history rows.
        const match = matches.find(x => Number(x.quantity_listed || 0) > 0) || matches[0];
        if (match) {
          return {
            manifest_id: match.manifest_id || manifest.id,
            manifest_name: manifest.name || '',
            manifest_status: manifest.status || '',
            listing: match,
            url: `https://app.sellerchamp.com/manifests/${encodeURIComponent(match.manifest_id || manifest.id)}?product_listing%5Bquery%5D=${encodeURIComponent(code)}`
          };
        }
        if (rows.length < 100) break;
      }
    }
    if (list.length < pageSize) break;
  }
  return null;
}

async function lookupProductById(productId) {
  if (!productId) return null;
  try {
    const detail = await scFetch(`/api/products/${encodeURIComponent(productId)}.json`);
    const raw = detail.product || detail || {};
    if (!raw || !raw.id) return null;
    try {
      const locData = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
      raw.inventory_locations = locData.inventory_locations || raw.inventory_locations || [];
    } catch {}
    return normalizeLegacyProduct(raw);
  } catch (e) {
    if ([400,404].includes(e.status)) return null;
    throw e;
  }
}

function applyManifestMatch(product, match) {
  if (!product || !match) return product;
  const listing = match.listing || {};
  product.manifest_id = match.manifest_id;
  product.manifest_name = match.manifest_name;
  product.batch_listing_id = listing.id || '';
  product.batch_product_id = listing.product_id || '';
  product.manifest_status = match.manifest_status;
  product.sellerchamp_batch_url = match.url;
  product.batch_listing_id = listing.id || '';
  product.batch_found = true;

  // For an unsubmitted item, Products may legitimately show zero/no locations.
  // Use the manifest listing's own location/quantity for warehouse display.
  const batchLocation = listing.location || listing.item_location || '';
  // Products inventory always wins. A historical Batch match must never force a
  // submitted Product back into Batch mode. Only use Batch inventory as the
  // authoritative fallback when Products has BOTH no inventory-location records
  // AND no available quantity (the not-yet-submitted pattern).
  const hasProductLocations = Array.isArray(product.locations) && product.locations.length > 0;
  const hasProductQuantity = Number(product.quantity_available || 0) > 0;
  const batchWasSubmitted = Number(listing.quantity_listed || 0) > 0;
  product.batch_quantity_listed = Number(listing.quantity_listed || 0);
  product.batch_was_submitted = batchWasSubmitted;
  if (!batchWasSubmitted && !hasProductLocations && !hasProductQuantity && batchLocation) {
    const qty = Number(listing.quantity ?? listing.quantity_available ?? 0);
    product.locations = [{
      id: '',
      location: batchLocation,
      quantity_available: qty,
      priority: 1,
      delete_if_empty: false,
      source: 'batch'
    }];
    product.location_source = 'batch';
    product.mode = 'batch';
  } else {
    // Keep Batch metadata/button for history/navigation, but do not let it alter
    // the Product-mode write path.
    product.location_source = hasProductLocations ? 'product' : (product.location_source || 'product');
  }
  if (!product.title && listing.title) product.title = listing.title;
  if (!product.sku && listing.sku) product.sku = listing.sku;

  // Explicit workflow consumed by the UI. A historical Batch association alone
  // never selects Batch controls.
  const hasWritableProductLocation = Array.isArray(product.locations) &&
    product.locations.some(x => x && x.id && String(x.location || '').trim());
  product.workflow = hasWritableProductLocation ? 'product' :
    (product.location_source === 'batch' ? 'batch' : 'product');
  return product;
}


async function getSubmittedShelfItems(location) {
  const items = [];
  for (let page=1; page<=20; page++) {
    let data;
    try {
      data = await scFetch(`/api/master_product_inventory_locations/items?location=${encodeURIComponent(location)}&page=${page}&page_size=250`);
    } catch (e) {
      // Catalog Sync may not be enabled. Return empty here; unsubmitted Batch
      // inventory can still be reported and item-by-item lookup still works.
      if ([400,404,422].includes(e.status)) return [];
      throw e;
    }
    const rows = Array.isArray(data.items) ? data.items : [];
    for (const x of rows) {
      items.push({
        status:'submitted',
        submitted:true,
        sku:x.catalogue_sku || x.sku || '',
        title:x.title || '',
        quantity:Number(x.quantity_available || 0),
        reserve_quantity:Number(x.reserve_quantity_count || 0),
        location,
        image:x.primary_image || x.image_url || '',
        master_product_id:x.master_product_id || x.id || '',
        source:'products'
      });
    }
    if (!data.pagination?.more || !rows.length) break;
  }
  return items;
}

const shelfBatchCache = new Map();

async function getUnsubmittedShelfItems(location) {
  const needle=String(location||'').trim().toLowerCase();
  const cached=shelfBatchCache.get(needle);
  if(cached && Date.now()-cached.savedAt<120000)return cached.items;
  const found=[];
  const seen=new Set();
  let data;
  try{ data=await scFetch('/api/manifests?page=1&page_size=50'); }
  catch(e){ if([400,404,422].includes(e.status)) return []; throw e; }

  let manifests=data.manifests||data.manifest||[];
  if(!Array.isArray(manifests)) manifests=manifests?[manifests]:[];
  // Not-yet-submitted inventory should live in current Batches. Skipping
  // completed/history Batches prevents hundreds of unnecessary API calls.
  manifests=manifests.filter(manifest=>{
    const status=String(manifest?.status||'').trim().toLowerCase();
    return !/(submitted|completed|complete|closed|archived|processed|cancelled|canceled)/.test(status);
  }).slice(0,30);

  for(const manifest of manifests){
      if(!manifest?.id)continue;
      for(let lp=1;lp<=5;lp++){
        let listingData;
        try{
          listingData=await scFetch(`/api/manifests/${encodeURIComponent(manifest.id)}/product_listings?page=${lp}&page_size=100`);
        }catch(e){ if([400,404,422].includes(e.status))break; throw e; }
        let rows=listingData.product_listings||listingData.product_listing||[];
        if(!Array.isArray(rows))rows=rows?[rows]:[];
        for(const x of rows){
          const rowLocation=String(x.location||x.item_location||'').trim();
          const unsubmitted=Number(x.quantity_listed||0)<=0;
          if(!unsubmitted || rowLocation.toLowerCase()!==needle)continue;
          const key=String(x.id||`${manifest.id}:${x.sku||x.catalogue_sku||''}`);
          if(seen.has(key))continue;
          seen.add(key);
          found.push({
            status:'not_submitted',
            submitted:false,
            sku:x.sku||x.catalogue_sku||x.custom_catalogue_sku||'',
            title:x.title||'',
            quantity:Number(x.quantity??x.quantity_available??0),
            reserve_quantity:0,
            location:rowLocation,
            image:x.primary_image||x.image_url||'',
            manifest_id:manifest.id,
            manifest_name:manifest.name||'',
            batch_listing_id:x.id||'',
            batch_url:`https://app.sellerchamp.com/manifests/${encodeURIComponent(manifest.id)}?product_listing%5Bquery%5D=${encodeURIComponent(x.sku||x.catalogue_sku||'')}`,
            source:'batch'
          });
        }
        if(rows.length<100)break;
      }
  }
  shelfBatchCache.set(needle,{savedAt:Date.now(),items:found});
  return found;
}

app.get('/api/shelf-report', async (req,res)=>{
  const location=String(req.query.location||'').trim();
  if(!location)return res.status(400).json({error:'Scan or enter a shelf location.'});
  try{
    // Submitted inventory and Batch inventory are independent sources, so run
    // them together to reduce shelf-report wait time.
    const [submittedResult,unsubmittedResult]=await Promise.allSettled([
      getSubmittedShelfItems(location),
      getUnsubmittedShelfItems(location)
    ]);

    const submitted=submittedResult.status==='fulfilled'?submittedResult.value:[];
    const unsubmitted=unsubmittedResult.status==='fulfilled'?unsubmittedResult.value:[];
    const warnings=[];
    if(submittedResult.status==='rejected'){
      console.error('Shelf Check submitted inventory failed:',submittedResult.reason);
      warnings.push('Submitted Products inventory could not be checked.');
    }
    if(unsubmittedResult.status==='rejected'){
      console.error('Shelf Check Batch inventory failed:',unsubmittedResult.reason);
      warnings.push('Not-yet-submitted Batch inventory could not be checked.');
    }

    // If an unsubmitted listing has the same SKU as submitted inventory, keep
    // both records: physically they may represent separate expected units.
    const items=[...submitted,...unsubmitted].sort((a,b)=>{
      if(a.submitted!==b.submitted)return a.submitted?-1:1;
      return String(a.sku).localeCompare(String(b.sku),undefined,{numeric:true});
    });
    res.json({
      location,
      submitted_count:submitted.length,
      not_submitted_count:unsubmitted.length,
      expected_quantity:items.reduce((n,x)=>n+Number(x.quantity||0),0),
      items,
      warnings
    });
  }catch(e){
    res.status(e.status||500).json({error:'Could not build shelf report.',details:e.data||e.message});
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const data = await scFetch('/api/marketplace_accounts');
    res.json({ ok: true, version: APP_VERSION, pinRequired: !!APP_PIN, accounts: (data.marketplace_accounts || []).map(a => ({ id: a.id, name: a.name, marketplace: a.marketplace })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'Could not connect to SellerChamp.', details: e.data || e.message });
  }
});

app.get('/api/lookup', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Enter or scan an SKU/barcode.' });
  try {
    let product = await lookupLegacy(code);
    if (!product) product = await lookupCatalog(code);

    // FAST PATH: if Products already returned a real inventory-location record,
    // it is immediately usable by this app. Do not scan Batches at all.
    if (product) {
      const hasWritableProductLocation = Array.isArray(product.locations) &&
        product.locations.some(x => x && x.id && String(x.location || '').trim());
      if (hasWritableProductLocation) {
        product.workflow = 'product';
        product.location_source = 'product';
        product.batch_found = false;
        product.batch_lookup_skipped = true;
        return res.json({ product });
      }
    }

    // SLOW FALLBACK: Products did not provide writable inventory. Only now search
    // SellerChamp Batches for an unsubmitted listing/location.
    let manifestMatch = null;
    try { manifestMatch = await findManifestForCode(code); } catch (e) {
      console.warn('Manifest lookup failed:', e.message);
    }

    if (manifestMatch && Number(manifestMatch.listing?.quantity_listed || 0) > 0 && manifestMatch.listing?.product_id) {
      // If the fallback discovers a submitted listing, follow its exact Product ID
      // once; this covers duplicate/draft Product rows without penalizing normal lookups.
      const submittedProduct = await lookupProductById(manifestMatch.listing.product_id);
      if (submittedProduct) {
        const hasSubmittedLocation = Array.isArray(submittedProduct.locations) &&
          submittedProduct.locations.some(x => x && x.id && String(x.location || '').trim());
        if (hasSubmittedLocation) {
          submittedProduct.workflow = 'product';
          submittedProduct.location_source = 'product';
          submittedProduct.submitted_from_batch = true;
          submittedProduct.batch_found = true;
          submittedProduct.manifest_id = manifestMatch.manifest_id;
          submittedProduct.manifest_name = manifestMatch.manifest_name;
          submittedProduct.sellerchamp_batch_url = manifestMatch.url;
          return res.json({ product: submittedProduct });
        }
        product = submittedProduct;
      }
    }

    if (product) {
      applyManifestMatch(product, manifestMatch);
      if (!product.workflow) product.workflow = product.location_source === 'batch' ? 'batch' : 'product';
      return res.json({ product });
    }

    // A listing can exist in an unsubmitted manifest before a usable Products
    // record exists. Still return it so the exact Batch button and location show.
    if (manifestMatch) {
      const x = manifestMatch.listing || {};
      const qty = Number(x.quantity_available ?? x.quantity ?? 0);
      return res.json({ product: {
        mode: 'batch',
        workflow: 'batch',
        id: x.product_id || x.id || '',
        sku: x.sku || code,
        catalogue_sku: x.catalogue_sku || x.custom_catalogue_sku || '',
        upc: x.upc || '',
        asin: x.asin || '',
        title: x.title || '',
        image: x.primary_image || x.image_url || '',
        locations: (x.location || x.item_location) ? [{id:'',location:(x.location || x.item_location),quantity_available:qty,source:'batch'}] : [],
        manifest_id: manifestMatch.manifest_id,
        manifest_name: manifestMatch.manifest_name,
        manifest_status: manifestMatch.manifest_status,
        batch_listing_id: x.id || '',
        batch_found: true,
        location_source: 'batch',
        sellerchamp_batch_url: manifestMatch.url
      }});
    }

    res.status(404).json({ error: `No SellerChamp item matched “${code}”.` });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'SellerChamp lookup failed.', details: e.data || e.message });
  }
});

app.get('/api/batch-diagnostic', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({error:'Enter a SKU.'});
  try {
    const match = await findManifestForCode(code);
    if (!match) return res.json({ok:true,found:false,sku:code});
    const x=match.listing||{};
    res.json({
      ok:true, found:true, sku:code,
      manifest_id:match.manifest_id,
      manifest_name:match.manifest_name,
      manifest_status:match.manifest_status,
      product_listing_id:x.id||'',
      product_id:x.product_id||'',
      listing_sku:x.sku||'',
      location:x.location||x.item_location||'',
      quantity:Number(x.quantity ?? x.quantity_available ?? 0),
      quantity_listed:Number(x.quantity_listed || 0),
      list_status:x.list_status || '',
      considered_submitted:Number(x.quantity_listed || 0) > 0,
      url:match.url
    });
  } catch(e) {
    res.status(e.status||500).json({error:'Batch diagnostic failed.',details:e.data||e.message});
  }
});


app.post('/api/update-location-quantity', async (req,res)=>{
  const {mode,productId,locationId,location,newQuantity,sku,title}=req.body||{};
  if(mode==='batch') return res.status(409).json({error:'Batch quantities must be changed in SellerChamp.'});
  if(mode!=='legacy') return res.status(409).json({error:'Quantity update is only enabled for standard SellerChamp inventory locations.'});
  const qty=Number(newQuantity);
  if(!productId || !locationId || !Number.isInteger(qty) || qty<0) return res.status(400).json({error:'Product, location, and a whole-number quantity of 0 or greater are required.'});
  try{
    const beforeData=await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
    const before=(beforeData.inventory_locations||[]).find(x=>String(x.id)===String(locationId));
    if(!before) return res.status(404).json({error:'The inventory location no longer exists. Look the item up again.'});
    const oldQty=Number(before.quantity_available||0);
    const payload={inventory_location:{
      location:String(before.location||location||'').trim(),
      quantity_available:qty,
      delete_if_empty:before.delete_if_empty!==false,
      priority:Number(before.priority||1)
    }};
    await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations/${encodeURIComponent(before.id)}`,{
      method:'PUT',body:JSON.stringify(payload)
    });
    const afterData=await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
    const after=(afterData.inventory_locations||[]).find(x=>String(x.id)===String(locationId));
    if(!after || Number(after.quantity_available)!==qty)
      return res.status(409).json({error:'SellerChamp did not confirm the quantity change. No success was reported.'});
    let log={logged:false};
    try{log=await logChange({
      app:'Location Mover',action:'Quantity Updated',sku:sku||'',title:title||'',
      oldLocation:String(before.location||location||''),newLocation:String(before.location||location||''),
      quantity:qty,details:`Quantity changed from ${oldQty} to ${qty}`
    });}catch(e){log={logged:false,warning:e.message||'Google Sheets logging failed'};}
    return res.json({success:true,oldQuantity:oldQty,newQuantity:qty,location:after.location,log});
  }catch(e){return res.status(e.status||500).json({error:'SellerChamp quantity update failed.',details:e.data||e.message});}
});

app.post('/api/move', async (req, res) => {
  const { mode, productId, fromLocation, toLocation, quantity, allQuantity, sourceLocationId, manifestId, batchListingId, sku, title } = req.body || {};
  if (mode === 'batch') {
    return res.status(409).json({
      error:'Batch location moves are temporarily disabled for safety. Open the SellerChamp Batch and edit the existing listing there.'
    });
  }

  if (!productId || !fromLocation || !toLocation) return res.status(400).json({ error: 'Product, source location, and destination location are required.' });
  if (String(fromLocation).trim().toLowerCase() === String(toLocation).trim().toLowerCase()) return res.status(400).json({ error: 'The new location is the same as the current location.' });

  try {
if (mode === 'catalog') {
      const body = {
        master_product_id: productId,
        inventory_action: 'transfer',
        from_location: String(fromLocation).trim(),
        location: String(toLocation).trim()
      };
      if (allQuantity) body.all_quantity = true;
      else {
        const q = Number(quantity);
        if (!Number.isInteger(q) || q <= 0) return res.status(400).json({ error: 'Quantity must be a whole number greater than zero.' });
        body.quantity = q;
      }
      const data = await scFetch('/api/master_product_inventory_locations/update_quantities', {
        method: 'POST', body: JSON.stringify(body)
      });

      let log={logged:false};
      try {
        log=await logChange({
          app:'Location Mover', action:'Location Move', sku:sku||'', title:title||'',
          oldLocation:String(fromLocation).trim(), newLocation:String(toLocation).trim(),
          quantity:allQuantity ? '' : Number(quantity),
          details:allQuantity ? 'Moved all quantity from source location' : ''
        });
      } catch(e) { log={logged:false,warning:e.message||'Google Sheets logging failed'}; }
      return res.json({ok:true,mode:'catalog',result:data,log});
    }

    if (mode === 'legacy') {
      if (!sourceLocationId) return res.status(400).json({ error: 'Legacy SellerChamp location ID is missing. Look the item up again.' });
      if (!allQuantity) return res.status(400).json({ error: 'Partial moves require SellerChamp Catalog Sync. In legacy mode, move the full quantity at this location.' });

      const locData = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
      const source = (locData.inventory_locations || []).find(x => x.id === sourceLocationId || x.location === fromLocation);
      if (!source) return res.status(404).json({ error: 'The source location no longer exists. Look the item up again.' });

      const payload = {
        inventory_location: {
          location: String(toLocation).trim(),
          quantity_available: Number(source.quantity_available || 0),
          delete_if_empty: source.delete_if_empty !== false,
          priority: Number(source.priority || 1)
        }
      };
      const data = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations/${encodeURIComponent(source.id)}`, {
        method: 'PUT', body: JSON.stringify(payload)
      });

      let log={logged:false};
      try {
        log=await logChange({
          app:'Location Mover', action:'Location Move', sku:sku||'', title:title||'',
          oldLocation:String(fromLocation).trim(), newLocation:String(toLocation).trim(),
          quantity:Number(source.quantity_available||0),
          details:'Moved full quantity from source location'
        });
      } catch(e) { log={logged:false,warning:e.message||'Google Sheets logging failed'}; }
      return res.json({ok:true,mode:'legacy',result:data,log});
    }

    res.status(400).json({ error: 'Unknown inventory mode. Look the item up again.' });
  } catch (e) {
    const details = e.data || e.message;
    const error = e.status === 422 ? 'SellerChamp rejected the inventory change.' : 'SellerChamp move failed.';
    res.status(e.status || 500).json({ error, details });
  }
});


app.delete('/api/inventory-location', async (req, res) => {
  const { productId, locationId, sku, title } = req.body || {};
  if (!productId || !locationId) return res.status(400).json({ error: 'Product ID and location ID are required.' });
  try {
    const locData = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
    const location = (locData.inventory_locations || []).find(x => String(x.id) === String(locationId));
    if (!location) return res.status(404).json({ error: 'That inventory location no longer exists.' });

    // Safety check: never delete a location unless SellerChamp currently reports Qty 0.
    if (Number(location.quantity_available || 0) !== 0) {
      return res.status(409).json({ error: 'This location no longer has quantity zero, so it was not deleted.' });
    }

    const payload = {
      inventory_location: {
        location: String(location.location || ''),
        quantity_available: 0,
        delete_if_empty: true,
        priority: Number(location.priority || 1)
      }
    };
    const data = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations/${encodeURIComponent(locationId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    // Verify SellerChamp actually removed the zero-quantity location.
    const verify = await scFetch(`/api/products/${encodeURIComponent(productId)}/inventory_locations`);
    const stillThere = (verify.inventory_locations || []).some(x => String(x.id) === String(locationId));
    if (stillThere) {
      return res.status(409).json({ error: 'SellerChamp accepted the cleanup request, but the zero-quantity location is still present.' });
    }
    const log=await logChange({
      app:'Location Mover',action:'Zero-Quantity Location Deleted',sku:sku||'',title:title||'',
      oldLocation:location.location||'(blank)',newLocation:'',quantity:0,
      details:'Removed zero-quantity inventory location'
    });
    res.json({ok:true,deletedLocation:location.location||'(blank)',result:data,log});
  } catch (e) {
    res.status(e.status || 500).json({ error: 'SellerChamp could not delete the zero-quantity location.', details: e.data || e.message });
  }
});

app.get('/api/locations', async (req, res) => {
  const query = String(req.query.q || '').trim();
  try {
    const data = await scFetch(`/api/master_product_inventory_locations?query=${encodeURIComponent(query)}&page=1&page_size=50`);
    res.json({ locations: data.inventory_locations || data.locations || [] });
  } catch (e) {
    // Catalog Sync may be disabled; autocomplete is optional.
    res.json({ locations: [] });
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`SellerChamp Inventory Checker v${APP_VERSION} running on port ${PORT}`));
