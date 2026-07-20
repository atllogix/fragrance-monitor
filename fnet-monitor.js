const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const STATE_FILE = path.join(__dirname, "state-fnet.json");
const EVENTS_FILE = path.join(__dirname, "events-fnet.json");

const SITE_KEY = "fnet";
const BASE_URL = "https://www.fragrancenet.com";

// ---- UTIL ----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function getDateParts() {
  const now = new Date();
  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    day: String(now.getUTCDate()).padStart(2, "0"),
  };
}

function getHistoryPaths() {
  const { year, month, day } = getDateParts();
  const folder = path.join(__dirname, "history", SITE_KEY, year, month);
  const fileMd = path.join(folder, `${year}-${month}-${day}.md`);
  const fileCsv = path.join(folder, `${year}-${month}-${day}.csv`);
  return { folder, fileMd, fileCsv };
}

// ---- STATE ----
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  return { firstRun: true, items: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- SCRAPER ----
async function fetchFnetPage(page = 1) {
  const url = `${BASE_URL}/search?term=perfume&page=${page}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (fnet-monitor bot)"
    }
  });

  if (!res.ok) {
    console.warn(`fnet page ${page} failed: ${res.status}`);
    return { products: [], hasMore: false };
  }

  const html = await res.text();

  const items = html
    .split('data-product-id="')
    .slice(1)
    .map(block => {
      const id = block.split('"')[0];
      const nameMatch = block.match(/class="product-name">([^<]+)/);
      const priceMatch = block.match(/class="price[^"]*">\$?([\d.,]+)/);
      const urlMatch = block.match(/href="([^"]+)"/);

      return {
        id,
        name: nameMatch ? nameMatch[1].trim() : null,
        price: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null,
        url: urlMatch ? BASE_URL + urlMatch[1] : null
      };
    });

  const hasMore = html.includes("Next Page");

  return { products: items, hasMore };
}

async function fetchAllFnet() {
  let all = [];
  let page = 1;

  while (true) {
    const { products, hasMore } = await fetchFnetPage(page);
    all.push(...products);
    if (!hasMore) break;
    page++;
    await sleep(1000);
  }

  return all;
}

// ---- HISTORY ----
function appendHistory(events) {
  if (!events.length) return;

  const { folder, fileMd, fileCsv } = getHistoryPaths();
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const mdLines = [`## ${timestamp}`, ""];
  events.forEach(e => {
    mdLines.push(`- **${e.type}** — [${e.name}](${e.url})`);
  });
  mdLines.push("");

  const mdBlock = mdLines.join("\n") + "\n";

  let existingMd = "";
  if (fs.existsSync(fileMd)) {
    existingMd = fs.readFileSync(fileMd, "utf8");
  }

  const mdHeader = `# fnet history — newest first\n\n`;
  fs.writeFileSync(fileMd, mdHeader + mdBlock + existingMd);

  const csvHeader = "Timestamp,Type,Name,OldPrice,NewPrice,URL";
  const newRows = events.map(e =>
    [
      new Date().toISOString(),
      e.type,
      e.name,
      e.oldPrice ?? "",
      e.newPrice ?? "",
      e.url
    ].map(csvEscape).join(",")
  );

  if (!fs.existsSync(fileCsv)) {
    fs.writeFileSync(fileCsv, [csvHeader, ...newRows].join("\n") + "\n");
  } else {
    fs.appendFileSync(fileCsv, newRows.join("\n") + "\n");
  }
}

// ---- EVENTS.JSON ----
function appendEventsJson(events) {
  if (!events.length) return;

  let existing = [];
  if (fs.existsSync(EVENTS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
    } catch {
      existing = [];
    }
  }

  const timestamp = new Date().toISOString();
  const enriched = events.map(e => ({ ...e, timestamp }));

  const all = [...enriched, ...existing];
  const trimmed = all.slice(0, 5000);

  fs.writeFileSync(EVENTS_FILE, JSON.stringify(trimmed, null, 2));
}

// ---- MAIN ----
(async function main() {
  const state = loadState();
  const events = [];

  console.log("Checking fnet...");
  const products = await fetchAllFnet();

  const prev = state.items;
  const next = {};
  const now = new Date().toISOString();

  for (const p of products) {
    const id = p.id;
    const prevItem = prev[id];

    next[id] = {
      price: p.price,
      timestamp: now
    };

    if (!state.firstRun && !prevItem) {
      events.push({
        type: "New Arrival",
        name: p.name,
        oldPrice: null,
        newPrice: p.price,
        url: p.url
      });
    }

    if (prevItem && p.price < prevItem.price) {
      events.push({
        type: "Price Drop",
        name: p.name,
        oldPrice: prevItem.price,
        newPrice: p.price,
        url: p.url
      });
    }
  }

  state.items = next;

  if (state.firstRun) {
    console.log("fnet baseline established.");
    state.firstRun = false;
  } else {
    console.log(`${events.length} fnet event(s) found.`);
    appendHistory(events);
    appendEventsJson(events);
  }

  saveState(state);
})();
