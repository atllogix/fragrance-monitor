const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const CATEGORY_ID = 5869;
const SHA256_HASH = 'c1eabb81061d464cb4d229da279dded5f77540f5c5dbcb86214c3040e48d2b84';
const PAGE_SIZE = 60;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = path.join(__dirname, 'jomashop-state.json');
const EVENTS_JSON_FILE = path.join(__dirname, 'events.json'); // shared with the Shopify monitor
const EVENTS_JSON_MAX_AGE_DAYS = 60;
const PAGE_DELAY_MS = 500;
const SAFETY_MAX_PAGES = 1000;

const BRAND_WATCHLIST = [];
const MIN_DISCOUNT_PCT = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function passesFilters(brand, discountPct) {
  if (BRAND_WATCHLIST.length > 0) {
    const allowed = BRAND_WATCHLIST.some((b) => b.toLowerCase() === (brand || '').toLowerCase());
    if (!allowed) return false;
  }
  if (discountPct !== null && discountPct < MIN_DISCOUNT_PCT) return false;
  return true;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function eventSummary(e) {
  let base;
  if (e.type.endsWith('Price Drop')) {
    base = `jomashop.com: ${e.title} — $${e.oldPrice} to $${e.newPrice}`;
  } else {
    base = `jomashop.com: ${e.title}`;
  }
  if (e.promoCode && e.effectivePrice !== null && e.effectivePrice !== undefined) {
    base += ` (code ${e.promoCode} → $${e.effectivePrice})`;
  }
  return base;
}

function isRealProductUrl(url) {
  if (!url) return false;
  return url !== 'https://www.jomashop.com' && url !== 'https://www.jomashop.com/';
}

function getPagesUrl() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) return null;
  const [owner, repo] = repoFull.split('/');
  return `https://${owner}.github.io/${repo}/`;
}

function todayParts() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return { y, m, d, ym: `${y}-${m}`, ymd: `${y}-${m}-${d}` };
}

function currentHistoryFileName(ext) {
  const { y, m, ymd } = todayParts();
  return `history/${y}/${m}/${ymd}.${ext}`;
}

async function sendDigest(events) {
  if (events.length === 0) {
    console.log('No qualifying changes this run — no notification sent.');
    return;
  }
  const counts = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  const summaryParts = Object.entries(counts).map(([type, n]) => `${n} ${type}`);
  const title = `Jomashop Alert: ${summaryParts.join(', ')}`;

  const MAX_LINES = 15;
  const lines = events.slice(0, MAX_LINES).map((e) => `• ${eventSummary(e)}`);
  const pagesUrl = getPagesUrl();
  if (events.length > MAX_LINES) {
    const overflowLink = pagesUrl || `the ${currentHistoryFileName('md')} file in your repo`;
    lines.push(`…and ${events.length - MAX_LINES} more — full list: ${overflowLink}`);
  }
  const body = lines.join('\n');

  console.log(`NOTIFY: ${title}\n${body}`);

  if (!NTFY_TOPIC) {
    console.warn('NTFY_TOPIC not set — skipping push notification.');
    return;
  }
  try {
    const headers = { Title: title };
    if (pagesUrl) headers.Click = pagesUrl;

    const validEvents = events.filter((e) => isRealProductUrl(e.url));
    const actionEvents = validEvents.slice(0, 3);
    if (actionEvents.length > 0) {
      const actions = actionEvents
        .map((e) => {
          const label = eventSummary(e).replace(/[,;]/g, '').slice(0, 35);
          return `view, ${label}, ${e.url}`;
        })
        .join('; ');
      headers.Actions = actions;
    }

    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: body,
    });
  } catch (err) {
    console.error('Failed to send ntfy notification:', err.message);
  }
}

function appendHistoryMarkdown(events) {
  if (events.length === 0) return;
  const MAX_HISTORY_LINES = 100;
  const capped = events.slice(0, MAX_HISTORY_LINES);

  const fileName = currentHistoryFileName('md');
  const filePath = path.join(__dirname, fileName);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const lines = [`## ${timestamp}`, ''];
    capped.forEach((e) => {
      lines.push(`- **${e.type}** — [${eventSummary(e)}](${e.url})`);
    });
    if (events.length > MAX_HISTORY_LINES) {
      lines.push(`- …and ${events.length - MAX_HISTORY_LINES} more this run (not logged — check the Actions run log)`);
    }
    lines.push('');
    const newBlock = lines.join('\n') + '\n';

    const { ymd } = todayParts();
    const header = `# Fragrance Monitor History — ${ymd} (newest first)\n\n`;

    let existingBody = '';
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      const firstSectionIdx = existing.indexOf('## ');
      existingBody = firstSectionIdx >= 0 ? existing.slice(firstSectionIdx) : '';
    }

    fs.writeFileSync(filePath, header + newBlock + existingBody);
    console.log(`History (md): wrote ${capped.length} event(s) to ${fileName}`);
  } catch (err) {
    console.error(`History (md) write FAILED for ${fileName}:`, err.message);
  }
}

function appendHistoryCsv(events) {
  if (events.length === 0) return;
  const fileName = currentHistoryFileName('csv');
  const filePath = path.join(__dirname, fileName);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString();
    const headerRow = 'Timestamp,Type,Domain,Brand,Title,OldPrice,NewPrice,DiscountPct,URL';
    const newRows = events.map((e) =>
      [timestamp, e.type, 'jomashop.com', e.brand || '', e.title, e.oldPrice ?? '', e.newPrice ?? '', e.discountPct ?? '', e.url]
        .map(csvEscape)
        .join(',')
    );

    let existingRows = [];
    if (fs.existsSync(filePath)) {
      existingRows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(1);
    }

    const allRows = [headerRow, ...newRows, ...existingRows];
    fs.writeFileSync(filePath, allRows.join('\n') + '\n');
    console.log(`History (csv): wrote ${events.length} event(s) to ${fileName}`);
  } catch (err) {
    console.error(`History (csv) write FAILED for ${fileName}:`, err.message);
  }
}

function appendEventsJson(events) {
  if (events.length === 0) return;
  try {
    let existing = [];
    if (fs.existsSync(EVENTS_JSON_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(EVENTS_JSON_FILE, 'utf8'));
      } catch {
        existing = [];
      }
    }

    const timestamp = new Date().toISOString();
    const newEntries = events.map((e) => ({
      timestamp,
      domain: 'jomashop.com',
      type: e.type,
      brand: e.brand || '',
      title: e.title,
      oldPrice: e.oldPrice,
      newPrice: e.newPrice,
      discountPct: e.discountPct,
      url: e.url,
      promoCode: e.promoCode || null,
      effectivePrice: e.effectivePrice ?? null,
    }));

    const cutoff = Date.now() - EVENTS_JSON_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const combined = [...existing, ...newEntries].filter((e) => new Date(e.timestamp).getTime() >= cutoff);

    fs.writeFileSync(EVENTS_JSON_FILE, JSON.stringify(combined, null, 2));
    console.log(`events.json: wrote ${newEntries.length} new event(s), ${combined.length} total in rolling window.`);
  } catch (err) {
    console.error('events.json write FAILED:', err.message);
  }
}

const PRICE_HISTORY_FILE = path.join(__dirname, 'price-history.csv');

function recordPriceHistory(rows) {
  if (!rows || rows.length === 0) return;
  const headerRow = 'Timestamp,Domain,Brand,Title,Price,URL';
  const newLines = rows.map((r) => r.map(csvEscape).join(','));

  if (!fs.existsSync(PRICE_HISTORY_FILE)) {
    fs.writeFileSync(PRICE_HISTORY_FILE, [headerRow, ...newLines].join('\n') + '\n');
  } else {
    fs.appendFileSync(PRICE_HISTORY_FILE, newLines.join('\n') + '\n');
  }
  console.log(`Price history: ${rows.length} new price point(s) recorded.`);
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  let totalPages = null;

  while (true) {
    const variables = {
      currentPage: page,
      id: CATEGORY_ID,
      onServer: true,
      pageSize: PAGE_SIZE,
      filter: { category_id: { eq: String(CATEGORY_ID) } },
      sort: { position: 'ASC' },
    };
    const extensions = {
      clientLibrary: { name: '@apollo/client', version: '4.2.6' },
      persistedQuery: { version: 1, sha256Hash: SHA256_HASH },
    };
    const url = `https://www.jomashop.com/graphql?operationName=category&variables=${encodeURIComponent(
      JSON.stringify(variables)
    )}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/graphql-response+json,application/json;q=0.9',
          'User-Agent': 'Mozilla/5.0 (fragrance-monitor bot)',
        },
      });
    } catch (err) {
      console.warn(`[jomashop] page ${page} fetch failed: ${err.message}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[jomashop] page ${page} returned status ${res.status}`);
      break;
    }

    const data = await res.json();
    const productsData = data?.data?.products;
    const items = productsData?.items || [];

    if (totalPages === null) {
      totalPages = productsData?.page_info?.total_pages;
      console.log(`[jomashop] total pages: ${totalPages}, total products: ${productsData?.total_count}`);
    }

    products.push(...items);

    if (!totalPages || page >= totalPages) break;
    page++;
    if (page > SAFETY_MAX_PAGES) {
      console.warn('[jomashop] safety page cap hit, stopping early.');
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }

  return products;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { firstRun: true, products: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

(async function main() {
  const state = loadState();
  const events = [];
  const priceHistoryRows = [];

  console.log('Checking jomashop.com (this can take a few minutes, ~437+ pages)...');
  const products = await fetchAllProducts();

  if (products === null) {
    console.warn('[jomashop] SKIPPED this cycle (fetch failed)');
  } else {
    const prevData = state.products || {};
    const newData = {};
    const timestamp = new Date().toISOString();
    let missingUrlKeyCount = 0;

    for (const p of products) {
      if (newData[p.id]) continue;

      const brand = p?.moredetails?.more_details_text?.manufacturer || '';
      const stockStatus = p.stock_status || '';
      const finalPrice = toNum(p?.price_range?.minimum_price?.final_price?.value);
      const productUrl = p.url_key ? `https://www.jomashop.com/${p.url_key}.html` : '';
      if (!p.url_key) missingUrlKeyCount++;

      // Promo/coupon code, if any — Jomashop exposes this per-product.
      const promoCode = p?.promotext_data_info?.promotext_code || '';
      const promoType = p?.promotext_data_info?.promotext_type || ''; // e.g. "percent" or "fixed"
      const promoValue = toNum(p?.promotext_data_info?.promotext_value);
      let effectivePrice = finalPrice;
      if (finalPrice !== null && promoCode && promoValue !== null) {
        if (promoType.toLowerCase().includes('percent')) {
          effectivePrice = Math.round(finalPrice * (1 - promoValue / 100) * 100) / 100;
        } else {
          effectivePrice = Math.round((finalPrice - promoValue) * 100) / 100;
        }
      }

      newData[p.id] = { name: p.name, stockStatus, price: finalPrice };

      const prev = prevData[p.id];

      if (finalPrice !== null) {
        const isNew = !prev;
        const changed = prev && prev.price !== null && prev.price !== finalPrice;
        if (isNew || changed) {
          priceHistoryRows.push([timestamp, 'jomashop.com', brand, p.name, finalPrice, productUrl]);
        }
      }

      // Only notify "New Arrival" if it's actually in stock.
      if (!state.firstRun && !prev && stockStatus === 'IN_STOCK') {
        if (passesFilters(brand, null)) {
          events.push({
            type: 'New Arrival',
            brand,
            title: p.name,
            oldPrice: null,
            newPrice: finalPrice,
            discountPct: null,
            url: productUrl,
            promoCode: promoCode || null,
            effectivePrice: promoCode ? effectivePrice : null,
          });
        }
      }

      if (prev) {
        if (prev.stockStatus !== 'IN_STOCK' && stockStatus === 'IN_STOCK') {
          if (passesFilters(brand, null)) {
            events.push({
              type: 'Restocked',
              brand,
              title: p.name,
              oldPrice: null,
              newPrice: finalPrice,
              discountPct: null,
              url: productUrl,
              promoCode: promoCode || null,
              effectivePrice: promoCode ? effectivePrice : null,
            });
          }
        }
        if (finalPrice !== null && prev.price !== null && finalPrice < prev.price) {
          const pct = Math.round((1 - finalPrice / prev.price) * 100);
          if (passesFilters(brand, pct)) {
            events.push({
              type: `${pct}% Price Drop`,
              brand,
              title: p.name,
              oldPrice: prev.price,
              newPrice: finalPrice,
              discountPct: pct,
              url: productUrl,
              promoCode: promoCode || null,
              effectivePrice: promoCode ? effectivePrice : null,
            });
          }
        }
      }
    }

    if (missingUrlKeyCount > 0) {
      console.warn(`[jomashop] ${missingUrlKeyCount} product(s) had no url_key field — their URL was left blank rather than pointing at the homepage.`);
    }

    state.products = newData;
    recordPriceHistory(priceHistoryRows);

    if (state.firstRun) {
      console.log('Baseline established. Notifications start from the next run onward.');
      state.firstRun = false;
    } else {
      console.log(`Check complete. ${events.length} qualifying event(s) found.`);
      await sendDigest(events);
      appendHistoryMarkdown(events);
      appendHistoryCsv(events);
      appendEventsJson(events);
    }

    saveState(state);
  }
})();
