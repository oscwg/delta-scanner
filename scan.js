#!/usr/bin/env node
/*
 * Node runner for the Delta Scanner engine. Used by the GitHub Actions workflow.
 *   SEC_USER_AGENT="Your Name your@email.com" node scan.js
 * Writes docs/data/flags.json (what the dashboard reads) and docs/data/history.json
 * (first-seen dates, so the dashboard can mark what is new since earlier runs).
 */
const fs = require('fs');
const path = require('path');
const DS = require('./engine.js');
const FL = require('./filings.js');

const UA = process.env.SEC_USER_AGENT || (fs.existsSync(path.join(__dirname, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).secUserAgent : '');
if (!UA || !/@/.test(UA)) {
  console.error('Set SEC_USER_AGENT to "Name email@domain" — the SEC blocks requests without a contact User-Agent.');
  process.exit(1);
}
const OUT = path.join(__dirname, 'docs', 'data');
fs.mkdirSync(OUT, { recursive: true });
const config = fs.existsSync(path.join(__dirname, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) : {};

// SEC fair-access: max 10 requests/second. We stay at ~8.
const MIN_GAP_MS = 125;
let next = 0;
async function slot() {
  const now = Date.now(); const wait = Math.max(0, next - now);
  next = Math.max(now, next) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

let consecutiveFailures = 0;
async function get(url, as) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await slot();
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', Accept: as === 'json' ? 'application/json' : '*/*' } }); // a hung request must not block a slot
    } catch (e) {
      // network down or SEC unreachable: give up quickly and keep the previous data rather than retrying for minutes
      if (++consecutiveFailures >= 12) { console.error(`SEC unreachable (${e.message}). Keeping previous data.`); process.exit(1); }
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt * attempt)); continue;
    }
    consecutiveFailures = 0;
    if (res.status === 404) return null;
    if (res.ok) return as === 'json' ? res.json() : res.text();
    if ((res.status === 429 || res.status >= 500 || res.status === 403) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt * attempt)); continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}
const fetchJson = (url) => get(url, 'json');
const fetchText = (url) => get(url, 'text');
const log = (m) => console.log(m);

(async () => {
  // 1. what landed on EDGAR in the last 48 hours (live feed, minutes old)
  let latest = [];
  try { latest = await FL.latestFilings({ fetchText, hours: config.freshHours || 48, forms: ['10-Q', '10-K', '8-K', '6-K'], log }); } catch (e) { log(`Latest-filings feed unavailable: ${e.message}`); }
  const fresh = {};
  for (const x of latest) if (/^10-[QK]/.test(x.form) && (!fresh[x.cik] || x.accepted > fresh[x.cik].accepted)) fresh[x.cik] = { form: x.form, accn: x.accn, accepted: x.accepted };

  // 2. score every company; filings that arrived recently are marked fresh and always kept
  const result = await DS.runScan({ fetchJson, config, log, fresh });

  // 3. corroborate with statements from the filings themselves (cached per filing, so each document is read once)
  const cachePath = path.join(OUT, 'quote-cache.json');
  const cache = { quotes: fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {} };
  const order = [...result.flags].sort((a, b) => (!!b.fresh - !!a.fresh) || b.score - a.score);
  await FL.corroborate(order, { fetchText, fetchJson, log, max: config.corroborateMax || 80, cache });
  const live = new Set(result.flags.filter((f) => f.corroboration).map((f) => `${f.accn}|${f.reasons.map((r) => r.rule).join(',')}`));
  for (const k of Object.keys(cache.quotes)) if (!live.has(k)) delete cache.quotes[k];

  // 4. earnings releases filed in the last 48h whose 10-Q hasn't arrived yet
  result.justReported = await FL.justReported(latest, result.universe, { fetchText, log, max: config.justReportedMax || 40, flaggedCiks: new Set(result.flags.map((f) => f.cik)) });
  // 5. large foreign listings (IFRS, own currency): results 6-Ks shown with their own results table, not scored
  if ((config.foreignWatchlist || []).length) {
    try {
      const tx = await fetchJson('https://www.sec.gov/files/company_tickers_exchange.json');
      const want = new Set(config.foreignWatchlist.map((t) => t.toUpperCase())); const watch = {};
      for (const [cik, name, ticker] of tx.data) if (want.has(String(ticker).toUpperCase()) && !watch[cik]) watch[cik] = { ticker, name };
      const foreign = await FL.foreignResults(latest, watch, { fetchText, log });
      result.justReported = foreign.concat(result.justReported);
    } catch (e) { log(`Foreign results skipped: ${e.message}`); }
  }
  result.meta.latestFeed = { hours: config.freshHours || 48, filings: latest.length, periodic: Object.keys(fresh).length, releases: latest.filter((x) => x.items.includes('2.02')).length, checkedAt: new Date().toISOString() };
  delete result.universe;

  // first-seen tracking: key = cik|period|rule
  const histPath = path.join(OUT, 'history.json');
  const history = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath, 'utf8')) : {};
  const today = result.meta.generatedAt.slice(0, 10);
  for (const f of result.flags) {
    let first = today;
    for (const r of f.reasons) {
      if (r.rule === 'event') continue;
      const k = `${f.cik}|${f.period}|${r.rule}`;
      if (!history[k]) history[k] = today;
      r.firstSeen = history[k];
      if (history[k] < first) first = history[k];
    }
    f.firstSeen = first;
  }
  const cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  for (const [k, d] of Object.entries(history)) if (d < cutoff) delete history[k];

  // sanity guard: never overwrite good data with an obviously broken run
  if (result.meta.companiesScanned < 200 && fs.existsSync(path.join(OUT, 'flags.json'))) {
    console.error(`Only ${result.meta.companiesScanned} companies scanned — looks like an SEC outage or block. Keeping previous data.`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT, 'flags.json'), JSON.stringify(result));
  fs.writeFileSync(histPath, JSON.stringify(history));
  fs.writeFileSync(cachePath, JSON.stringify(cache.quotes));
  console.log(`Wrote ${result.flags.length} flags (${(fs.statSync(path.join(OUT, 'flags.json')).size / 1024).toFixed(0)} KB).`);
})().catch((e) => { console.error(e); process.exit(1); });
