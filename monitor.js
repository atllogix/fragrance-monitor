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

const NTFY_TOPIC = process.env.NTFY_TOPIC; // set as a GitHub repo secret
const STATE_FILE = path.join(__dirname, 'state.json');
const PAGE_DELAY_MS = 1000;
const SITE_DELAY_MS = 1500;

// Optional filters — leave as-is to catch everything, tighten later if you want fewer alerts.
const BRAND_WATCHLIST = []; // e.g. ['Shauran', 'Creed'] — empty array = notify for all brands
const MIN_DISCOUNT_PCT = 5; // filters out cent-level rounding noise being flagged as a "drop"

// Sites known to run apps that periodically rewrite their own product prices
// (e.g. fee/surcharge widgets), which creates false "price drop" noise.
const SKIP_PRICE_MONITORING = ['olfactoryfactoryllc.com', 'aurafragrance.com'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function passesFilters(brand, discountPct) {
  if (BRAND_WATCHLIST.length > 0) {
    const allowed = BRAND_WATCHLIST.some(
      (b) => b.toLowerCase() === (brand || '').toLowerCase()
    );
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

function currentHistoryFileName(ext) {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `history/${ym}.${ext}`;
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
  if (events.length > MAX_LINES) {
    const repoFull = process.env.GITHUB_REPOSITORY;
    const historyPath = currentHistoryFileName('md');
    const historyUrl = repoFull
      ? `https://github.com/${repoFull}/blob/main/${historyPath}`
      : `the ${historyPath} file in your repo`;
    lines.push(`…and ${events.length - MAX_LINES} more — full list: ${historyUrl}`);
  }
  const body = lines.join('\n');

  console.log(`NOTIFY: ${title}\n${body}`);

  if (!NTFY_TOPIC) {
    console.warn('NTFY_TOPIC not set — skipping push notification.');
    return;
  }
  try {
    const headers = { Title: title };
    headers.Click = events[0].url;

    const actionEvents = events.slice(0, 3);
    const actions = actionEvents
      .map((e) => {
        const label = eventSummary(e).replace(/[,;]/g, '').slice(0, 35);
        return `view, ${label}, ${e.url}`;
      })
      .join('; ');
    headers.Actions = actions;

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
  const MAX_HISTORY_LINES = 100; // hard safety cap — prevents one bad run from exploding file size
  const capped = events.slice(0, MAX_HISTORY_LINES);

  const fileName = currentHistoryFileName('md');
  const filePath = path.join(__dirname, fileName);
  const dir = path.dirname(filePath);
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

  const monthLabel = fileName.replace('history/', '').replace('.md', '');
  const header = `# Fragrance Monitor History — ${monthLabel} (newest first)\n\n`;

  let existingBody = '';
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    const firstSectionIdx = existing.indexOf('## ');
    existingBody = firstSectionIdx >= 0 ? existing.slice(firstSectionIdx) : '';
  }

  fs.writeFileSync(filePath, header + newBlock + existingBody);
}

function appendHistoryCsv(events) {
  if (events.length === 0) return;
  const fileName = currentHistoryFileName('csv');
  const filePath = path.join(__dirname, fileName);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const headerRow = 'Timestamp,Type,Domain,Brand,Title,OldPrice,NewPrice,DiscountPct,URL';
  const newRows = events.map((e) =>
    [
      timestamp,
      e.type,
      e.domain,
      e.brand || '',
      e.title,
      e.oldPrice ?? '',
      e.newPrice ?? '',
      e.discountPct ?? '',
      e.url,
    ]
      .map(csvEscape)
      .join(',')
  );

  let existingRows = [];
  if (fs.existsSync(filePath)) {
    existingRows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(1);
  }

  const allRows = [headerRow, ...newRows, ...existingRows]; // newest first
  fs.writeFileSync(filePath, allRows.join('\n') + '\n');
}

async function fetchAllProducts(domain) {
  const products = [];
  let url = `https://${domain}/products.json?limit=250`;
  let pageCount = 0;
  const MAX_PAGES = 200;

  while (url) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (fragrance-monitor bot)' },
      });
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

  for (const p of products) {
    const variants = {};
    (p.variants || []).forEach((v) => {
      variants[v.id] = { available: v.available, price: parseFloat(v.price) };
    });
    newData[p.id] = { title: p.title, handle: p.handle, variants };

    const prevProduct = prevData[p.id];
    const productUrl = `https://${domain}/products/${p.handle}`;
    const brand = (p.vendor || '').trim();
    const firstVariant = (p.variants || [])[0];
    const currentPrice = firstVariant ? parseFloat(firstVariant.price) : null;

    // Price-history: one row when a product is first seen (baseline point),
    // and one row every time its price genuinely changes — not every run.
    if (priceHistoryRows && currentPrice !== null && !SKIP_PRICE_MONITORING.includes(domain)) {
      const prevFirstVariant = prevProduct && firstVariant ? prevProduct.variants[firstVariant.id] : null;
      const isNew = !prevProduct;
      const changed = prevFirstVariant && prevFirstVariant.price !== currentPrice;
      if (isNew || changed) {
        priceHistoryRows.push([timestamp, domain, brand, p.title, currentPrice, productUrl]);
      }
    }

    if (!state.firstRun && !prevProduct) {
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

  state.sites[domain] = newData;
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
  }

  saveState(state);
})();
