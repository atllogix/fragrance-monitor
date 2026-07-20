const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const CATEGORY_ID = 5869; // Jomashop's Fragrances category
const SHA256_HASH = 'c1eabb81061d464cb4d229da279dded5f77540f5c5dbcb86214c3040e48d2b84';
const PAGE_SIZE = 60;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = path.join(__dirname, 'jomashop-state.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');
const PAGE_DELAY_MS = 500;
const SAFETY_MAX_PAGES = 1000;

const BRAND_WATCHLIST = [];
const MIN_DISCOUNT_PCT = 0;

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

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function githubPagesUrl() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!repoFull) return null;
  const [owner, name] = repoFull.split('/');
  return `https://${owner}.github.io/${name}/`;
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
  const lines = events.slice(0, MAX_LINES).map((e) => `• ${e.summary}`);
  if (events.length > MAX_LINES) {
    lines.push(`…and ${events.length - MAX_LINES} more — see events.json / history in the repo`);
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
    headers.Click = pagesUrl || (events[0] && events[0].url) || 'https://www.jomashop.com/fragrances';

    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: body,
    });
  } catch (err) {
    console.error('Failed to send ntfy notification:', err.message);
  }
}

function appendEventsJson(events) {
  if (!events || events.length === 0) return;

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
  const normalized = events.map((e) => ({
    type: e.type,
    domain: 'jomashop.com',
    brand: e.brand || '',
    title: e.name || e.summary || '',
    oldPrice: e.oldPrice ?? null,
    newPrice: e.newPrice ?? null,
    discountPct: e.discountPct ?? null,
    url: e.url,
    timestamp,
  }));

  const all = [...normalized, ...existing];
  const MAX_EVENTS = 5000;
  const trimmed = all.slice(0, MAX_EVENTS);

  fs.writeFileSync(EVENTS_FILE, JSON.stringify(trimmed, null, 2));
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
      console.log(
        `[jomashop] total pages: ${totalPages}, total products: ${productsData?.total_count}`
      );
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

  console.log('Checking jomashop.com (this can take a few minutes)...');
  const products = await fetchAllProducts();

  if (products === null) {
    console.warn('[jomashop] SKIPPED this cycle (fetch failed)');
  } else {
    const prevData = state.products || {};
    const newData = {};

    for (const p of products) {
      if (newData[p.id]) continue;

      const brand = p?.moredetails?.more_details_text?.manufacturer || '';
      const stockStatus = p.stock_status || '';
      const finalPrice = toNum(p?.price_range?.minimum_price?.final_price?.value);
      const productUrl = p.url_key ? `https://www.jomashop.com/${p.url_key}.html` : '';

      newData[p.id] = { name: p.name, stockStatus, price: finalPrice };

      const prev = prevData[p.id];

      if (!state.firstRun && !prev) {
        if (passesFilters(brand, null)) {
          events.push({
            type: 'New Arrival',
            summary: `jomashop.com: ${p.name}`,
            url: productUrl,
            brand,
            name: p.name,
          });
        }
      }

      if (prev) {
        if (prev.stockStatus !== 'IN_STOCK' && stockStatus === 'IN_STOCK') {
          if (passesFilters(brand, null)) {
            events.push({
              type: 'Restocked',
              summary: `jomashop.com: ${p.name}`,
              url: productUrl,
              brand,
              name: p.name,
            });
          }
        }
        if (finalPrice !== null && prev.price !== null && finalPrice < prev.price) {
          const pct = Math.round((1 - finalPrice / prev.price) * 100);
          if (passesFilters(brand, pct)) {
            events.push({
              type: `${pct}% Price Drop`,
              summary: `jomashop.com: ${p.name} — $${prev.price} to $${finalPrice}`,
              url: productUrl,
              brand,
              name: p.name,
              oldPrice: prev.price,
              newPrice: finalPrice,
              discountPct: pct,
            });
          }
        }
      }
    }

    state.products = newData;

    if (state.firstRun) {
      console.log('Baseline established. Notifications start from the next run onward.');
      state.firstRun = false;
    } else {
      console.log(`Check complete. ${events.length} qualifying event(s) found.`);
      await sendDigest(events);
      appendEventsJson(events);
    }

    saveState(state);
  }
})();

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

  console.log('Checking jomashop.com (this can take a few minutes, ~437+ pages)...');
  const products = await fetchAllProducts();

  if (products === null) {
    console.warn('[jomashop] SKIPPED this cycle (fetch failed)');
  } else {
    const prevData = state.products || {};
    const newData = {};

    for (const p of products) {
      if (newData[p.id]) continue; // dedupe within this run

      const brand = p?.moredetails?.more_details_text?.manufacturer || '';
      const stockStatus = p.stock_status || '';
      const finalPrice = toNum(p?.price_range?.minimum_price?.final_price?.value);
      const productUrl = p.url_key ? `https://www.jomashop.com/${p.url_key}.html` : '';

      newData[p.id] = { name: p.name, stockStatus, price: finalPrice };

      const prev = prevData[p.id];

      if (!state.firstRun && !prev) {
        if (passesFilters(brand, null)) {
          events.push({ type: 'New Arrival', summary: `jomashop.com: ${p.name}`, url: productUrl });
        }
      }

      if (prev) {
        if (prev.stockStatus !== 'IN_STOCK' && stockStatus === 'IN_STOCK') {
          if (passesFilters(brand, null)) {
            events.push({ type: 'Restocked', summary: `jomashop.com: ${p.name}`, url: productUrl });
          }
        }
        if (finalPrice !== null && prev.price !== null && finalPrice < prev.price) {
          const pct = Math.round((1 - finalPrice / prev.price) * 100);
          if (passesFilters(brand, pct)) {
            events.push({
              type: `${pct}% Price Drop`,
              summary: `jomashop.com: ${p.name} — $${prev.price} to $${finalPrice}`,
              url: productUrl,
            });
          }
        }
      }
    }

    state.products = newData;

    if (state.firstRun) {
      console.log('Baseline established. Notifications start from the next run onward.');
      state.firstRun = false;
    } else {
      console.log(`Check complete. ${events.length} qualifying event(s) found.`);
      await sendDigest(events);
      appendHistory(events);
    }

    saveState(state);
  }
})();
