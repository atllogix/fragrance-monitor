const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ---- CONFIG ----
const SITES = [
  'olfactoryfactoryllc.com',
  'beautyliv.com',
  'aurafragrance.com',
  'venbafragrance.com',
  'fragrapedia.com',
  'theparfums.com',
  'jomashop.com' // unified includes joma here
];

const NTFY_TOPIC = process.env.NTFY_TOPIC; // set as a GitHub repo secret
const STATE_FILE = path.join(__dirname, 'state.json');
const PAGE_DELAY_MS = 1000;
const SITE_DELAY_MS = 1500;

const BRAND_WATCHLIST = [];
const MIN_DISCOUNT_PCT = 5;

const SKIP_PRICE_MONITORING = ['olfactoryfactoryllc.com', 'aurafragrance.com'];

const EVENTS_FILE = path.join(__dirname, 'events.json');
const PRICE_HISTORY_FILE = path.join(__dirname, 'price-history.csv');

// ---- UTIL ----
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

function githubPagesUrl() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) return null;
  const [owner, name] = repoFull.split('/');
  return `https://${owner}.github.io/${name}/`;
}

// ---- DATE + HISTORY PATHS ----
function getDateParts() {
  const now = new Date();
  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
    day: String(now.getUTCDate()).padStart(2, '0'),
  };
}

// global: history/global/YYYY/MM/YYYY-MM-DD.md
function getGlobalHistoryPath() {
  const { year, month, day } = getDateParts();
  const folder = path.join(__dirname, 'history', 'global', year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  return { folder, fileMd };
}

// per-site: history/<siteKey>/YYYY/MM/YYYY-MM-DD.{md,csv}
// jomashop → "joma"
function siteKeyFromDomain(domain) {
  if (domain === 'jomashop.com') return 'joma';
  return domain;
}

function getSiteHistoryPaths(domain) {
  const key = siteKeyFromDomain(domain);
  const { year, month, day } = getDateParts();
  const folder = path.join(__dirname, 'history', key, year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  const fileCsv = path.join(folder, `${year}-${month}-${day}.csv`);
  return { folder, fileMd, fileCsv };
}

// ---- HISTORY WRITERS ----
function appendGlobalHistory(events) {
  if (!events.length) return;

  const { folder, fileMd } = getGlobalHistoryPath();
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [`## ${timestamp}`, ''];
  events.forEach((e) => {
    lines.push(`- **${e.type}** — [${eventSummary(e)}](${e.url})`);
  });
  lines.push('');

  const block = lines.join('\n') + '\n';

  let existing = '';
  if (fs.existsSync(fileMd)) {
    existing = fs.readFileSync(fileMd, 'utf8');
  }

  const header = `# Fragrance Monitor Global History — newest first\n\n`;
  fs.writeFileSync(fileMd, header + block + existing);
}

function appendSiteHistory(domain, events) {
  if (!events.length) return;

  const { folder, fileMd, fileCsv } = getSiteHistoryPaths(domain);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // MD
  const mdLines = [`## ${timestamp}`, ''];
  events.forEach((e) => {
    mdLines.push(`- **${e.type}** — [${eventSummary(e)}](${e.url})`);
  });
  mdLines.push('');
  const mdBlock = mdLines.join('\n') + '\n';

  let existingMd = '';
  if (fs.existsSync(fileMd)) {
    existingMd = fs.readFileSync(fileMd, 'utf8');
  }
  const mdHeader = `# ${siteKeyFromDomain(domain)} history — newest first\n\n`;
  fs.writeFileSync(fileMd, mdHeader + mdBlock + existingMd);

  // CSV
  const csvHeader =
    'Timestamp,Type,Domain,Brand,Title,OldPrice,NewPrice,DiscountPct,URL';
  const newRows = events.map((e) =>
    [
      new Date().toISOString(),
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

  if (!fs.existsSync(fileCsv)) {
    fs.writeFileSync(fileCsv, [csvHeader, ...newRows].join('\n') + '\n');
  } else {
    fs.appendFileSync(fileCsv, newRows.join('\n') + '\n');
  }
}

// ---- EVENTS.JSON ----
function appendEventsJson(events) {
  if (!events || !events.length) return;

  let existing = [];
  if (fs.existsSync(EVENTS_FILE)) {
    try {
      const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
  }

  const timestamp = new Date().toISOString();
  const enriched = events.map((e) => ({ ...e, timestamp }));

  const all = [...enriched, ...existing];
  const MAX_EVENTS = 5000;
  const trimmed = all.slice(0, MAX_EVENTS);

  fs.writeFileSync(EVENTS_FILE, JSON.stringify(trimmed, null, 2));
}

// ---- NTFY ----
async function sendDigest(events) {
  if (!events.length) {
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
    const pagesUrl = githubPagesUrl();
    lines.push(
      `…and ${events.length - MAX_LINES} more — see dashboard: ${
        pagesUrl || 'GitHub Pages'
      }`
    );
  }
  const body = lines.join('\n');

  console.log(`NOTIFY: ${title}\n${body}`);

  if (!NTFY_TOPIC) {
    console.warn('NTFY_TOPIC not set — skipping push notification.');
    return;
  }

  try {
    const headers = { Title: title };

    const pagesUrl = githubPagesUrl();
    headers.Click = pagesUrl || events[0].url;

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
      body,
    });
  } catch (err) {
    console.error('Failed to send ntfy notification:', err.message);
  }
}

// ---- STATE ----
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { firstRun: true, sites: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- SHOPIFY FETCH ----
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
    if (!items.length) break;
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

// ---- SITE CHECK ----
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

    if (priceHistoryRows && currentPrice !== null && !SKIP_PRICE_MONITORING.includes(domain)) {
      const prevFirstVariant =
        prevProduct && firstVariant ? prevProduct.variants[firstVariant.id] : null;
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

// ---- PRICE HISTORY CSV (GLOBAL) ----
function recordPriceHistory(rows) {
  if (!rows || !rows.length) return;
  const headerRow = 'Timestamp,Domain,Brand,Title,Price,URL';
  const newLines = rows.map((r) => r.map(csvEscape).join(','));

  if (!fs.existsSync(PRICE_HISTORY_FILE)) {
    fs.writeFileSync(PRICE_HISTORY_FILE, [headerRow, ...newLines].join('\n') + '\n');
  } else {
    fs.appendFileSync(PRICE_HISTORY_FILE, newLines.join('\n') + '\n');
  }
  console.log(`Price history: ${rows.length} new price point(s) recorded.`);
}

// ---- MAIN ----
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

    if (events.length) {
      await sendDigest(events);

      // per-site history
      const byDomain = events.reduce((acc, e) => {
        (acc[e.domain] ||= []).push(e);
        return acc;
      }, {});
      for (const [domain, siteEvents] of Object.entries(byDomain)) {
        appendSiteHistory(domain, siteEvents);
      }

      // global history + dashboard
      appendGlobalHistory(events);
      appendEventsJson(events);
    }
  }

  saveState(state);
})();
