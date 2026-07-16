const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const SITES = [
  'olfactoryfactoryllc.com',
  'beautyliv.com',
  'aurafragrance.com',
  'venbafragrance.com',
  'fragrapedia.com'
];

const NTFY_TOPIC = process.env.NTFY_TOPIC; // set as a GitHub repo secret
const STATE_FILE = path.join(__dirname, 'state.json');
const HISTORY_FILE = path.join(__dirname, 'history.md');
const PAGE_DELAY_MS = 1000;
const SITE_DELAY_MS = 1500;

// Optional filters — leave as-is to catch everything, tighten later if you want fewer alerts.
const BRAND_WATCHLIST = []; // e.g. ['Shauran', 'Creed'] — empty array = notify for all brands
const MIN_DISCOUNT_PCT = 0; // e.g. 20 = only notify price drops of 20% or more; 0 = notify any drop

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
  const lines = events.slice(0, MAX_LINES).map((e) => `• ${e.summary}`);
  if (events.length > MAX_LINES) {
    lines.push(`…and ${events.length - MAX_LINES} more — see history.md in the repo`);
  }
  const body = lines.join('\n');

  console.log(`NOTIFY: ${title}\n${body}`);

  if (!NTFY_TOPIC) {
    console.warn('NTFY_TOPIC not set — skipping push notification.');
    return;
  }
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title },
      body: body,
    });
  } catch (err) {
    console.error('Failed to send ntfy notification:', err.message);
  }
}

function appendHistory(events) {
  if (events.length === 0) return;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [`## ${timestamp}`, ''];
  events.forEach((e) => {
    lines.push(`- **${e.type}** — [${e.summary}](${e.url})`);
  });
  lines.push('');
  const block = lines.join('\n') + '\n';

  const existing = fs.existsSync(HISTORY_FILE)
    ? fs.readFileSync(HISTORY_FILE, 'utf8')
    : '# Fragrance Monitor History\n\n';
  fs.writeFileSync(HISTORY_FILE, existing + block);
}

async function fetchAllProducts(domain) {
  const products = [];
  let page = 1;
  while (true) {
    const url = `https://${domain}/products.json?limit=250&page=${page}`;
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
      console.warn(`[${domain}] page ${page} returned status ${res.status}`);
      break;
    }
    const data = await res.json();
    const items = data.products || [];
    if (items.length === 0) break;
    products.push(...items);
    if (items.length < 250) break;
    page++;
    await sleep(PAGE_DELAY_MS);
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

async function checkSite(domain, state, events) {
  const products = await fetchAllProducts(domain);
  if (products === null) {
    console.warn(`[${domain}] SKIPPED this cycle (fetch failed)`);
    return;
  }

  const prevData = state.sites[domain] || {};
  const newData = {};

  for (const p of products) {
    const variants = {};
    (p.variants || []).forEach((v) => {
      variants[v.id] = { available: v.available, price: parseFloat(v.price) };
    });
    newData[p.id] = { title: p.title, handle: p.handle, variants };

    const prevProduct = prevData[p.id];
    const productUrl = `https://${domain}/products/${p.handle}`;
    const brand = (p.vendor || '').trim();

    if (!state.firstRun && !prevProduct) {
      if (passesFilters(brand, null)) {
        events.push({
          type: 'New Arrival',
          summary: `${domain}: ${p.title}`,
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
                summary: `${domain}: ${p.title}`,
                url: productUrl,
              });
            }
          }
          if (v.price < prevVariant.price) {
            const pct = Math.round((1 - v.price / prevVariant.price) * 100);
            if (passesFilters(brand, pct)) {
              events.push({
                type: `${pct}% Price Drop`,
                summary: `${domain}: ${p.title} — $${prevVariant.price} to $${v.price}`,
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

(async function main() {
  const state = loadState();
  const events = [];

  for (const domain of SITES) {
    console.log(`Checking ${domain}...`);
    await checkSite(domain, state, events);
    await sleep(SITE_DELAY_MS);
  }

  if (state.firstRun) {
    console.log('Baseline established. Notifications start from the next run onward.');
    state.firstRun = false;
  } else {
    console.log(`Check complete. ${events.length} qualifying event(s) found.`);
    await sendDigest(events);
    appendHistory(events);
  }

  saveState(state);
})();
