const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const BASE_URL = 'https://www.fragrancenet.com/fn/fragrances';
const NTFY_TOPIC = process.env.NTFY_TOPIC; // same repo secret as the other monitors
const STATE_FILE = path.join(__dirname, 'fragrancenet-state.json');
const EVENTS_JSON_FILE = path.join(__dirname, 'events.json'); // shared with the other monitors
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
    base = `fragrancenet.com: ${e.title} — $${e.oldPrice} to $${e.newPrice}`;
  } else {
    base = `fragrancenet.com: ${e.title}`;
  }
  if (e.effectivePrice !== null && e.effectivePrice !== undefined) {
    base += e.promoCode
      ? ` (code ${e.promoCode} → $${e.effectivePrice})`
      : ` (auto-discount applied → $${e.effectivePrice})`;
  }
  return base;
}

function isRealProductUrl(url) {
  if (!url) return false;
  return url !== 'https://www.fragrancenet.com' && url !== 'https://www.fragrancenet.com/';
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
  return { ymd: `${y}-${m}-${d}`, y, m };
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
  const title = `FragranceNet Alert: ${summaryParts.join(', ')}`;

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
      [timestamp, e.type, 'fragrancenet.com', e.brand || '', e.title, e.oldPrice ?? '', e.newPrice ?? '', e.discountPct ?? '', e.url]
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
      domain: 'fragrancenet.com',
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

const PRICE_HISTORY_FILE = path.join(__dirname, 'price-history.csv'); // shared with the other monitors

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

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  let totalPages = null;
  let coupon = null;

  while (true) {
    const url = `${BASE_URL}?page=${page}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (fragrance-monitor bot)' } });
    } catch (err) {
      console.warn(`[fragrancenet] page ${page} fetch failed: ${err.message}`);
      return { products: null, coupon: null };
    }
    if (!res.ok) {
      console.warn(`[fragrancenet] page ${page} returned status ${res.status}`);
      break;
    }
    const html = await res.text();
    const data = extractNextData(html);
    if (!data) {
      console.warn(`[fragrancenet] page ${page}: could not find/parse __NEXT_DATA__`);
      break;
    }

    const pageData = data?.props?.pageProps?.pageData;
    const results = pageData?.results || [];

    if (totalPages === null) {
      totalPages = pageData?.pagination?.numOfPages;
      console.log(`[fragrancenet] total pages: ${totalPages}, total products: ${pageData?.pagination?.numOfResults}`);

      // Sitewide coupon lives in the same page data — only need to read it once.
      const couponRaw = data?.props?.pageProps?.layoutData?.cartData?.coupon;
      if (couponRaw && couponRaw.type === 'percent' && couponRaw.amount) {
        coupon = { pct: couponRaw.amount, code: couponRaw.couponId || null, endDate: couponRaw.endDate || null };
        console.log(`[fragrancenet] active sitewide discount: ${coupon.pct}% off${coupon.code ? `, code ${coupon.code}` : ' (auto-applied, no code)'}${coupon.endDate ? `, ends ${coupon.endDate}` : ''}`);
      } else {
        console.log('[fragrancenet] no active sitewide coupon found this run.');
      }
    }

    products.push(...results);

    if (!totalPages || page >= totalPages) break;
    page++;
    if (page > SAFETY_MAX_PAGES) {
      console.warn('[fragrancenet] safety page cap hit, stopping early.');
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }

  return { products, coupon };
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

  console.log('Checking fragrancenet.com (this can take several minutes, ~782 pages)...');
  const { products, coupon } = await fetchAllProducts();

  if (products === null) {
    console.warn('[fragrancenet] SKIPPED this cycle (fetch failed)');
  } else {
    const prevData = state.products || {};
    const newData = {};
    const timestamp = new Date().toISOString();
    let missingPathCount = 0;

    for (const p of products) {
      if (!p.sku || newData[p.sku]) continue; // dedupe within this run

      const brand = (p.designer || '').trim(); // actual company name, not the fragrance line
      const title = `${p.brand || ''} ${p.description || ''}`.trim();
      const price = p.price !== undefined ? parseFloat(p.price) : null;
      const outOfStock = !!p.outOfStock;
      const productUrl = p.productPath ? `https://www.fragrancenet.com/fn/${p.productPath}#${p.sku}` : '';
      if (!p.productPath) missingPathCount++;

      let promoCode = null;
      let effectivePrice = null;
      if (coupon && price !== null) {
        promoCode = coupon.code; // null for FragranceNet's auto-applied stealth coupons
        effectivePrice = Math.round(price * (1 - coupon.pct / 100) * 100) / 100;
      }

      newData[p.sku] = { title, price, outOfStock };

      const prev = prevData[p.sku];

      if (price !== null) {
        const isNew = !prev;
        const changed = prev && prev.price !== null && prev.price !== price;
        if (isNew || changed) {
          priceHistoryRows.push([timestamp, 'fragrancenet.com', brand, title, price, productUrl]);
        }
      }

      // Only notify "New Arrival" if it's actually in stock.
      if (!state.firstRun && !prev && !outOfStock) {
        if (passesFilters(brand, null)) {
          events.push({
            type: 'New Arrival',
            brand,
            title,
            oldPrice: null,
            newPrice: price,
            discountPct: null,
            url: productUrl,
            promoCode,
            effectivePrice,
          });
        }
      }

      if (prev) {
        if (prev.outOfStock && !outOfStock) {
          if (passesFilters(brand, null)) {
            events.push({
              type: 'Restocked',
              brand,
              title,
              oldPrice: null,
              newPrice: price,
              discountPct: null,
              url: productUrl,
              promoCode,
              effectivePrice,
            });
          }
        }
        if (price !== null && prev.price !== null && price < prev.price) {
          const pct = Math.round((1 - price / prev.price) * 100);
          if (passesFilters(brand, pct)) {
            events.push({
              type: `${pct}% Price Drop`,
              brand,
              title,
              oldPrice: prev.price,
              newPrice: price,
              discountPct: pct,
              url: productUrl,
              promoCode,
              effectivePrice,
            });
          }
        }
      }
    }

    if (missingPathCount > 0) {
      console.warn(`[fragrancenet] ${missingPathCount} product(s) had no productPath — their URL was left blank rather than pointing at the homepage.`);
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
