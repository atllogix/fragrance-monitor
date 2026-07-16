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
const PAGE_DELAY_MS = 1000;
const SITE_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notify(title, body, url, imageUrl) {
  console.log(`NOTIFY: ${title} — ${body}`);
  if (!NTFY_TOPIC) {
    console.warn('NTFY_TOPIC not set — skipping push notification.');
    return;
  }
  try {
    const headers = {
      Title: title,
      Click: url || '',
    };
    if (imageUrl) {
      headers.Attach = imageUrl;
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

async function checkSite(domain, state) {
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
    const imageUrl = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || null;

    if (!state.firstRun && !prevProduct) {
      await notify('New Arrival', `${domain}: ${p.title}`, productUrl, imageUrl);
    }

    if (prevProduct) {
      for (const [variantId, v] of Object.entries(variants)) {
        const prevVariant = prevProduct.variants[variantId];
        if (prevVariant) {
          if (!prevVariant.available && v.available) {
            await notify('Restocked', `${domain}: ${p.title}`, productUrl, imageUrl);
          }
          if (v.price < prevVariant.price) {
            const pct = Math.round((1 - v.price / prevVariant.price) * 100);
            await notify(
              `${pct}% Price Drop`,
              `${domain}: ${p.title} — $${prevVariant.price} to $${v.price}`,
              productUrl,
              imageUrl
            );
          }
        }
      }
    }
  }

  state.sites[domain] = newData;
}

(async function main() {
  const state = loadState();

  for (const domain of SITES) {
    console.log(`Checking ${domain}...`);
    await checkSite(domain, state);
    await sleep(SITE_DELAY_MS);
  }

  if (state.firstRun) {
    console.log('Baseline established. Notifications start from the next run onward.');
    state.firstRun = false;
  } else {
    console.log('Check complete.');
  }

  saveState(state);
})();
