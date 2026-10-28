// Offline test: synthetic SEC frames for a handful of fake companies with known shocks.
const assert = require('assert');
const DS = require('../engine.js');
const { qiOf, qLabel } = DS._internal;

const NOW = new Date('2026-10-27T12:00:00Z');
const tEnd = qiOf(2026, 3);
const qs = []; for (let q = tEnd - 11; q <= tEnd; q++) qs.push(q);
const qEnd = (qi) => { const y = Math.floor(qi / 4), q = qi % 4; return new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10); };
const qStart = (qi) => { const y = Math.floor(qi / 4), q = qi % 4; return new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10); };

// companies: cik -> generator(concept, qi) => value|undefined
const base = (v, g = 0.01) => (qi) => v * (1 + g * (qi - qs[0]));
const C = {
  1001: { name: 'STEADY CORP', ticker: 'STDY', f: { revenue: base(2e9), netIncome: base(2e8), opIncome: base(3e8), cash: base(1e9), assets: base(2e10), debt: base(5e9), equity: base(8e9) } },
  1002: { name: 'CASHBURN INC', ticker: 'BURN', f: { revenue: base(1e9), netIncome: base(5e7), opIncome: base(8e7), cash: (q) => (q === tEnd ? 4e8 : 3e9 * (1 + 0.01 * (q - qs[0]))), assets: base(1.2e10), debt: base(2e9), equity: base(5e9) } },
  1003: { name: 'SWING HOLDINGS', ticker: 'SWNG', f: { revenue: base(3e9), netIncome: (q) => (q === tEnd ? -6e8 : 2e8), opIncome: (q) => (q === tEnd ? -5e8 : 3e8), cash: base(1e9), assets: base(2.5e10), debt: base(4e9), equity: base(9e9), goodwill: (q) => (q === tEnd ? 1e9 : 3e9) } },
  1004: { name: 'TINY CO', ticker: 'TINY', f: { revenue: base(2e7), netIncome: (q) => (q === tEnd ? -5e7 : 1e6), assets: base(1e8), cash: base(1e7) } },
  1005: { name: 'DECFY Q4 CORP', ticker: 'DECQ', f: { revenue: base(1.5e9), netIncome: base(1e8), assets: base(1e10), cash: base(1e9) }, noQ4: true },
};

const CONCEPT_BY_TAG = {};
for (const [ck, c] of Object.entries(DS.CONCEPTS)) CONCEPT_BY_TAG[c.tags[0]] = ck;

async function fetchJson(url) {
  if (url.includes('company_tickers_exchange')) return { fields: ['cik', 'name', 'ticker', 'exchange'], data: Object.entries(C).map(([cik, c]) => [+cik, c.name, c.ticker, 'NYSE']) };
  if (url.includes('/submissions/')) {
    const cik = +url.match(/CIK(\d+)/)[1];
    if (cik === 1003) return { sic: '3674', sicDescription: 'Semiconductors', tickers: ['SWNG'], filings: { recent: { accessionNumber: ['0001-26-000001'], filingDate: ['2026-10-01'], form: ['8-K'], items: ['2.06,9.01'], primaryDocument: ['x.htm'] } } };
    return { sic: '1000', sicDescription: 'Test', filings: { recent: { accessionNumber: [], filingDate: [], form: [], items: [], primaryDocument: [] } } };
  }
  const m = url.match(/us-gaap\/(\w+)\/USD\/CY(\d{4})(?:Q(\d))?(I?)\.json/);
  const [, tag, y, q, inst] = m; const ck = CONCEPT_BY_TAG[tag];
  if (!ck) return null;
  const data = [];
  for (const [cik, c] of Object.entries(C)) {
    const fn = c.f[ck]; if (!fn) continue;
    if (!q) { // annual
      if (!c.noQ4) continue;
      const yr = +y; const vals = [1, 2, 3, 4].map((k) => fn(qiOf(yr, k)));
      data.push({ cik: +cik, entityName: c.name, accn: 'A-' + yr, start: `${yr}-01-01`, end: `${yr}-12-31`, val: vals.reduce((a, b) => a + b, 0) });
      continue;
    }
    const qi = qiOf(+y, +q);
    if (c.noQ4 && !inst && +q === 4) continue;
    const v = fn(qi); if (v === undefined) continue;
    data.push({ cik: +cik, entityName: c.name, accn: 'Q-' + qLabel(qi), start: inst ? undefined : qStart(qi), end: qEnd(qi), val: Math.round(v) });
  }
  return { data };
}

(async () => {
  const logs = [];
  const res = await DS.runScan({ fetchJson, now: NOW, log: (m) => logs.push(m) });
  const by = Object.fromEntries(res.flags.map((f) => [f.ticker, f]));
  console.log(logs.join('\n'));
  for (const f of res.flags) console.log(`\n${f.ticker} score=${f.score} conf=${f.confidence}\n  ` + f.reasons.map((r) => `[${r.label} ${r.severity}] ${r.text}`).join('\n  '));

  assert(!by.STDY, 'steady company should not be flagged');
  assert(!by.TINY, 'tiny company is below size threshold');
  assert(by.BURN && by.BURN.primary === 'cashDrop', 'cash collapse caught');
  assert(by.SWNG && by.SWNG.reasons.some((r) => r.rule === 'niSwing' && r.label === 'Swung to loss'), 'swing to loss caught');
  assert(by.SWNG.reasons.some((r) => r.rule === 'goodwillHit'), 'goodwill hit caught');
  assert(by.SWNG.reasons.some((r) => r.rule === 'event' && /impairment/.test(r.text)), '8-K 2.06 overlay');
  assert(by.SWNG.reasons.some((r) => r.rule === 'marginShift'), 'margin compression caught');
  assert(res.meta.derivedQ4 >= 2, 'fiscal Q4 derived from annual');
  assert(!by.DECQ, 'Q4 derivation should not create false shocks for a smooth company');
  assert.strictEqual(res.meta.latestQuarter, '2026Q3');
  console.log('\nAll engine tests passed. derivedQ4 =', res.meta.derivedQ4);
})().catch((e) => { console.error(e); process.exit(1); });
