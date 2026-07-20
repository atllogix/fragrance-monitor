// jomashop-monitor.js — cleaned, with history + CSV

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const STATE_FILE = 'jomashop-state.json';
const EVENTS_FILE = 'events.json';

// GitHub Pages dashboard URL
const pagesUrl = `https://${process.env.GITHUB_REPOSITORY.split('/')[0]}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`;

// ---------- STATE / EVENTS ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { firstRun: true, products: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendEventsJson(events) {
  if (!events.length) return;

  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  } catch {}

  const updated = [...existing, ...events];
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(updated, null, 2));
}

// ---------- HISTORY PATH HELPERS ----------

function getDateParts() {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return { year, month, day };
}

// Global history: history/YYYY/MM/YYYY-MM-DD.md
function getGlobalHistoryPaths() {
  const { year, month, day } = getDateParts();
  const folder = path.join('history', year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  return { folder, fileMd };
}

// Jomashop-specific history: history/jomashop/YYYY/MM/YYYY-MM-DD.md + .csv
function getJomaHistoryPaths() {
  const { year, month, day } = getDateParts();
  const folder = path.join('history', 'jomashop', year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  const fileCsv = path.join(folder, `${year}-${month}-${day}.csv`);
  return { folder, fileMd, fileCsv };
}

// ---------- HISTORY WRITERS ----------

function appendGlobalHistory(events) {
  if (!events.length) return;

  const { folder, fileMd } = getGlobalHistoryPaths();
  fs.mkdirSync(folder, { recursive: true });

  const lines = events.map(e => `- [${e.type}] ${e.summary} (${e.url})`);
  const content = lines.join('\n') + '\n';

  fs.appendFileSync(fileMd, content);
}

function appendJomaHistory(events) {
  if (!events.length) return;

  const { folder, fileMd, fileCsv } = getJomaHistoryPaths();
  fs.mkdirSync(folder, { recursive: true });

  // Markdown
  const mdLines = events.map(
    e => `- [${e.type}] ${e.summary} (${e.url})`
  );
  const mdContent = mdLines.join('\n') + '\n';
  fs.appendFileSync(fileMd, mdContent);

  // CSV
  const headers = [
    'type',
    'summary',
    'url',
    'brand',
    'name',
    'oldPrice',
    'newPrice',
    'discountPct'
  ];

  let csv = '';
  if (!fs.existsSync(fileCsv)) {
    csv += headers.join(',') + '\n';
  }

  for (const e of events) {
    const row = [
      e.type ?? '',
      e.summary ?? '',
      e.url ?? '',
      e.brand ?? '',
      e.name ?? '',
      e.oldPrice ?? '',
      e.newPrice ?? '',
      e.discountPct ?? ''
    ]
      .map(v => String(v).replace(/"/g, '""'))
      .map(v => `"${v}"`)
      .join(',');

    csv += row + '\n';
  }

  fs.appendFileSync(fileCsv, csv);
}

// ---------- NTFY DIGEST ----------

async function sendDigest(events) {
  if (!events.length) return;

  const body = events.map(e => `• ${e.summary}`).join('\n');

  await fetch('https://ntfy.sh/fragrance-monitor', {
    method: 'POST',
    headers: {
      Title: `Jomashop Alert: ${events.length} New Arrival`,
      Click: pagesUrl, // always dashboard, not history.md
      Tags: 'label,price_tag',
    },
    body,
  });
}

// ---------- FILTERS ----------

function passesFilters(brand, pct) {
  // adjust as needed
  return pct >= 10;
}

// ---------- JOMASHOP SCRAPER ----------

async function fetchJomashop() {
  const url = 'https://www.jomashop.com/sitemap_products_1.xml';
  console.log('Checking jomashop.com (this can take a few minutes, ~437+ pages)...');

  const res = await fetch(url);
  const xml = await res.text();

  const products = [];
  const regex = /<url>([\s\S]*?)<\/url>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const block = match[1];
    const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    const name = block.match(/<image:title>(.*?)<\/image:title>/)?.[1];
    const price = block.match(/<price>(.*?)<\/price>/)?.[1];

    if (!loc || !name || !price) continue;

    products.push({
      url: loc,
      name,
      price: parseFloat(price),
      brand: name.split(' ')[0],
    });
  }

  console.log(`[jomashop] total products: ${products.length}`);
  return products;
}

// ---------- MAIN ----------

(async () => {
  const state = loadState();
  const newData = {};
  const events = [];

  console.log('Fetching Jomashop…');
  const products = await fetchJomashop();

  for (const p of products) {
    const productUrl = p.url;
    const brand = p.brand;
    const finalPrice = p.price;

    const prev = state.products[productUrl] || { price: null };

    newData[productUrl] = { price: finalPrice, name: p.name };

    if (!state.firstRun) {
      if (prev.price !== null && finalPrice < prev.price) {
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

    // history: global + jomashop-specific
    appendGlobalHistory(events);
    appendJomaHistory(events);

    // dashboard data
    appendEventsJson(events);
  }

  saveState(state);
})();
