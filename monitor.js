const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const SITES = [
  'olfactoryfactoryllc.com',
  'beautyliv.com',
  'aurafragrance.com',
  'venbafragrance.com',
  'fragrapedia.com',
  'theparfums.com'
];

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = path.join(__dirname, 'state.json');
const EVENTS_JSON_FILE = path.join(__dirname, 'events.json');
const EVENTS_JSON_MAX_AGE_DAYS = 60; // rolling window for the dashboard page
const PAGE_DELAY_MS = 1000;
const SITE_DELAY_MS = 1500;

const BRAND_WATCHLIST = [];
const MIN_DISCOUNT_PCT = 5;
const SKIP_PRICE_MONITORING = ['olfactoryfactoryllc.com', 'aurafragrance.com'];

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
  if (e.type.endsWith('Price Drop')) {
    return `${e.domain}: ${e.title} — $${e.oldPrice} to $${e.newPrice}`;
  }
  return `${e.domain}: ${e.title}`;
}

// A URL only counts as "real" if it's non-empty and isn't just the bare domain root
// (which is what caused notifications to silently point at homepages before).
function isRealProductUrl(url, domain) {
  if (!url) return false;
  const bare1 = `https://${domain}`;
  const bare2 = `https://${domain}/`;
  return url !== bare1 && url !== bare2;
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
  const title = `Fragrance Alert: ${summaryParts.join(', ')}`;

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

    // Main tap target: the dashboard page (today's view), not a single product —
    // this is the reliable link now, always valid regardless of any one product's data.
    if (pagesUrl) headers.Click = pagesUrl;

    // Up to 3 direct product buttons — only from events with a verified real URL,
    // so we never again silently point a button at a bare homepage.
    const validEvents = events.filter((e) => isRealProductUrl(e.url, e.domain));
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
      [timestamp, e.type, e.domain, e.brand || '', e.title, e.oldPrice ?? '', e.newPrice ?? '', e.discountPct ?? '', e.url]
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
      domain: e.domain,
      type: e.type,
      brand: e.brand || '',
      title: e.title,
      oldPrice: e.oldPrice,
      newPrice: e.newPrice,
      discountPct: e.discountPct,
      url: e.url,
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

async function fetchAllProducts(domain) {
  const products = [];
  let url = `https://${domain}/products.json?limit=250`;
  let pageCount = 0;
  const MAX_PAGES = 200;

  while (url) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (fragrance-monitor bot)' } });
    } catch (err) {
      console.warn(`[${domain}] fetch failed: ${err.message}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[${domain}] request returned status ${res.status}`);
      break;
    }
    const data = await res.json();
    const items = data.products || [];
    if (items.length === 0) break;
    products.push(...items);

    const linkHeader = res.headers.get('link');
    let nextUrl = null;
    if (linkHeader) {
      const nextPart = linkHeader.split(',').find((part) => part.includes('rel="next"'));
      if (nextPart) {
        const match = nextPart.match(/<([^>]+)>/);
        if (match) nextUrl = match[1];
      }
    }
    url = nextUrl;

    pageCount++;
    if (pageCount > MAX_PAGES) {
      console.warn(`[${domain}] safety page cap hit, stopping early.`);
      break;
    }
    if (url) await sleep(PAGE_DELAY_MS);
  }

  return products;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { firstRun: true, sites: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkSite(domain, state, events, priceHistoryRows) {
  const products = await fetchAllProducts(domain);
  if (products === null) {
    console.warn(`[${domain}] SKIPPED this cycle (fetch failed)`);
    return;
  }

  const prevData = state.sites[domain] || {};
  const newData = {};
  const timestamp = new Date().toISOString();
  let missingHandleCount = 0;

  for (const p of products) {
    const variants = {};
    (p.variants || []).forEach((v) => {
      variants[v.id] = { available: v.available, price: parseFloat(v.price) };
    });
    newData[p.id] = { title: p.title, handle: p.handle, variants };

    const prevProduct = prevData[p.id];
    const productUrl = p.handle ? `https://${domain}/products/${p.handle}` : '';
    if (!p.handle) missingHandleCount++;

    const brand = (p.vendor || '').trim();
    const firstVariant = (p.variants || [])[0];
    const currentPrice = firstVariant ? parseFloat(firstVariant.price) : null;
    const currentAvailable = firstVariant ? firstVariant.available : false;

    if (priceHistoryRows && currentPrice !== null && !SKIP_PRICE_MONITORING.includes(domain)) {
      const prevFirstVariant = prevProduct && firstVariant ? prevProduct.variants[firstVariant.id] : null;
      const isNew = !prevProduct;
      const changed = prevFirstVariant && prevFirstVariant.price !== currentPrice;
      if (isNew || changed) {
        priceHistoryRows.push([timestamp, domain, brand, p.title, currentPrice, productUrl]);
      }
    }

    // Only notify "New Arrival" if it's actually available — an out-of-stock item
    // being seen for the first time isn't something worth an alert for.
    if (!state.firstRun && !prevProduct && currentAvailable) {
      if (passesFilters(brand, null)) {
        events.push({
          type: 'New Arrival',
          domain,
          brand,
          title: p.title,
          oldPrice: null,
          newPrice: currentPrice,
          discountPct: null,
          url: productUrl,
        });
      }
    }

    if (prevProduct) {
      for (const [variantId, v] of Object.entries(variants)) {
        const prevVariant = prevProduct.variants[variantId];
        if (prevVariant) {
          if (!prevVariant.available && v.available) {
            if (passesFilters(brand, null)) {
              events.push({
                type: 'Restocked',
                domain,
                brand,
                title: p.title,
                oldPrice: null,
                newPrice: v.price,
                discountPct: null,
                url: productUrl,
              });
            }
          }
          if (v.price < prevVariant.price && !SKIP_PRICE_MONITORING.includes(domain)) {
            const pct = Math.round((1 - v.price / prevVariant.price) * 100);
            if (passesFilters(brand, pct)) {
              events.push({
                type: `${pct}% Price Drop`,
                domain,
                brand,
                title: p.title,
                oldPrice: prevVariant.price,
                newPrice: v.price,
                discountPct: pct,
                url: productUrl,
              });
            }
          }
        }
      }
    }
  }

  if (missingHandleCount > 0) {
    console.warn(`[${domain}] ${missingHandleCount} product(s) had no handle field — their URL was left blank rather than pointing at the homepage.`);
  }

  state.sites[domain] = newData;
}

(async function main() {
  const state = loadState();
  const events = [];
  const priceHistoryRows = [];

  for (const domain of SITES) {
    console.log(`Checking ${domain}...`);
    await checkSite(domain, state, events, priceHistoryRows);
    await sleep(SITE_DELAY_MS);
  }

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
})();
