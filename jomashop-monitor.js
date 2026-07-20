const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ---- CONFIG ----
const DOMAIN = 'jomashop.com';
const STATE_FILE = path.join(__dirname, 'joma-state.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');

const MIN_DISCOUNT_PCT = 5;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// ---- UTIL ----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function passesFilters(discountPct) {
  if (discountPct !== null && discountPct < MIN_DISCOUNT_PCT) return false;
  return true;
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

// history/joma/YYYY/MM/YYYY-MM-DD.md + .csv
function getJomaHistoryPaths() {
  const { year, month, day } = getDateParts();
  const folder = path.join(__dirname, 'history', 'joma', year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  const fileCsv = path.join(folder, `${year}-${month}-${day}.csv`);
  return { folder, fileMd, fileCsv };
}

// ---- HISTORY WRITERS ----
function appendJomaHistory(events) {
  if (!events.length) return;

  const { folder, fileMd, fileCsv } = getJomaHistoryPaths();
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // MD
  const mdLines = [`## ${timestamp}`, ''];
  events.forEach((e) => {
    mdLines.push(`- **${e.type}** — [${e.summary}](${e.url})`);
  });
  mdLines.push('');
  const mdBlock = mdLines.join('\n') + '\n';

  let existingMd = '';
  if (fs.existsSync(fileMd)) {
    existingMd = fs.readFileSync(fileMd, 'utf8');
  }

  const mdHeader = `# JOMA History — newest first\n\n`;
  fs.writeFileSync(fileMd, mdHeader + mdBlock + existingMd);

  // CSV
  const csvHeader =
    'Timestamp,Type,Brand,Title,OldPrice,NewPrice,DiscountPct,URL';

  const newRows = events.map((e) =>
    [
      new Date().toISOString(),
      e.type,
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
  if (!events.length) return;

  let existing = [];
  if (fs.existsSync(EVENTS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
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
  if (!events.length) return;

  const counts = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  const summaryParts = Object.entries(counts).map(([type, n]) => `${n} ${type}`);
  const title = `JOMA Alert: ${summaryParts.join(', ')}`;

  const MAX_LINES = 15;
  const lines = events.slice(0, MAX_LINES).map((e) => `• ${e.summary}`);
  if (events.length > MAX_LINES) {
    const pagesUrl = githubPagesUrl();
    lines.push(
      `…and ${events.length - MAX_LINES} more — see dashboard: ${
        pagesUrl || 'GitHub Pages'
      }`
    );
  }
  const body = lines.join('\n');

  if (!NTFY_TOPIC) return;

  try {
    const headers = { Title: title };
    const pagesUrl = githubPagesUrl();
    headers.Click = pagesUrl || events[0].url;

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
  return { firstRun: true, products: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- JOMA SCRAPER ----
async function fetchJoma() {
  const url = 'https://www.jomashop.com/sitemap_products_1.xml';
  console.log('Checking JOMA (this can take a few minutes)…');

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

  return products;
}

// ---- MAIN ----
(async () => {
  const state = loadState();
  const newData = {};
  const events = [];

  const products = await fetchJoma();

  for (const p of products) {
    const productUrl = p.url;
    const brand = p.brand;
    const finalPrice = p.price;

    const prev = state.products[productUrl] || { price: null };

    newData[productUrl] = { price: finalPrice, name: p.name };

    if (!state.firstRun) {
      if (prev.price !== null && finalPrice < prev.price) {
        const pct = Math.round((1 - finalPrice / prev.price) * 100);
        if (passesFilters(pct)) {
          events.push({
            type: `${pct}% Price Drop`,
            summary: `jomashop.com: ${p.name} — $${prev.price} to $${finalPrice}`,
            url: productUrl,
            brand,
            title: p.name,
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
    console.log('JOMA baseline established. Notifications start next run.');
    state.firstRun = false;
  } else {
    console.log(`JOMA check complete. ${events.length} qualifying event(s).`);

    if (events.length) {
      await sendDigest(events);
      appendJomaHistory(events);
      appendEventsJson(events);
    }
  }

  saveState(state);
})();
