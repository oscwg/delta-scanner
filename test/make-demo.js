// Builds docs/data/flags.json from FICTIONAL companies so the dashboard can be previewed
// before the first live scan. Every name and number here is invented. The live scan overwrites it.
const fs = require('fs');
const path = require('path');
const DS = require('../engine.js');
const { qiOf, qLabel } = DS._internal;

const NOW = new Date('2026-10-27T06:17:00Z');
const tEnd = qiOf(2026, 3);
const qs = []; for (let q = tEnd - 11; q <= tEnd; q++) qs.push(q);
const qEnd = (qi) => { const y = Math.floor(qi / 4), q = qi % 4; return new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10); };
const qStart = (qi) => { const y = Math.floor(qi / 4), q = qi % 4; return new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10); };

let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noisy = (v, g, n = 0.04) => (qi) => v * (1 + g * (qi - qs[0])) * (1 + (rnd() - 0.5) * 2 * n);
const at = (fn, overrides) => (qi) => (qi in overrides ? overrides[qi] : fn(qi));
const L = tEnd, P = tEnd - 1;

const C = {
  2001: { name: 'Northbeam Logistics (demo)', t: 'DMO.NBL', f: { revenue: noisy(2.4e9, 0.01), netIncome: noisy(1.8e8, 0.01, 0.1), opIncome: noisy(2.6e8, 0.01, 0.08), cash: at(noisy(3.1e9, 0.01), { [L]: 9.5e8 }), assets: noisy(1.9e10, 0.005), debt: at(noisy(4.2e9, 0), { [L]: 4.6e9 }), equity: noisy(7.8e9, 0.01) } },
  2002: { name: 'Corvane Biosciences (demo)', t: 'DMO.CVB', f: { revenue: noisy(6.1e8, 0.02), netIncome: at(noisy(6e7, 0.0, 0.2), { [L]: -4.3e8 }), opIncome: at(noisy(8e7, 0, 0.2), { [L]: -3.9e8 }), cash: noisy(1.4e9, 0), assets: noisy(5.2e9, 0.01), goodwill: at(noisy(1.6e9, 0, 0.005), { [L]: 9.8e8 }), equity: noisy(3.1e9, 0) }, events: [['2026-10-14', '2.06,9.01'], ['2026-09-02', '5.02']] },
  2003: { name: 'Meridian Grid Holdings (demo)', t: 'DMO.MGH', f: { revenue: at(noisy(1.1e9, 0.01), { [L]: 1.95e9, [L - 1]: 1.2e9 }), netIncome: noisy(1.2e8, 0.01, 0.1), opIncome: noisy(2e8, 0.01, 0.1), cash: noisy(6e8, 0), assets: at(noisy(1.2e10, 0.004), { [L]: 2.3e10 }), debt: at(noisy(3.5e9, 0), { [L]: 9.8e9 }), equity: noisy(5e9, 0.01) }, events: [['2026-08-21', '2.01,2.03,9.01']] },
  2004: { name: 'Halden Apparel Group (demo)', t: 'DMO.HAG', f: { revenue: at(noisy(1.6e9, 0.005), { [L]: 1.21e9 }), netIncome: at(noisy(1.1e8, 0, 0.1), { [L]: -6e7 }), opIncome: at(noisy(1.7e8, 0, 0.1), { [L]: -2.5e7 }), cash: noisy(4e8, 0), assets: noisy(6.5e9, 0.002), inventory: at(noisy(9e8, 0.005), { [L]: 1.55e9 }), receivables: noisy(3e8, 0.005), equity: noisy(2.6e9, 0) }, events: [['2026-10-02', '2.05,7.01']] },
  2005: { name: 'Ostrava Semiconductor (demo)', t: 'DMO.OSC', f: { revenue: at(noisy(3e9, 0.02), { [L]: 5.9e9 }), netIncome: at(noisy(3.5e8, 0.02, 0.1), { [L]: 1.9e9 }), opIncome: at(noisy(4.6e8, 0.02, 0.1), { [L]: 2.4e9 }), cash: at(noisy(2.2e9, 0.01), { [L]: 5.1e9 }), assets: noisy(2.1e10, 0.01), receivables: at(noisy(1.1e9, 0.02), { [L]: 2.9e9 }), equity: noisy(1.4e10, 0.01) } },
  2006: { name: 'Tamsin Retail Partners (demo)', t: 'DMO.TRP', f: { revenue: noisy(4e9, 0.0), netIncome: noisy(6e7, 0, 0.2), opIncome: noisy(1.4e8, 0, 0.15), cash: noisy(3e8, 0), assets: noisy(9e9, 0), equity: at(noisy(6e8, -0.02), { [L]: -3.1e8, [P]: 1.2e8 }), debt: noisy(4.5e9, 0.01) }, events: [['2026-09-18', '3.01']] },
  2007: { name: 'Kestrel Insurance Holdings (demo)', t: 'DMO.KIH', f: { revenue: noisy(2.2e9, 0.01), netIncome: at(noisy(2.1e8, 0.01, 0.08), { [L]: 5.6e8 }), opIncome: at(noisy(2.8e8, 0.01, 0.08), { [L]: 7.4e8 }), cash: noisy(1.1e9, 0), assets: noisy(4.4e10, 0.004), equity: noisy(9e9, 0.01) } },
  2008: { name: 'Redgate Media Corp (demo)', t: 'DMO.RMC', f: { revenue: noisy(1.3e9, -0.01), netIncome: noisy(4e7, 0, 0.3), opIncome: at(noisy(1.95e8, -0.005, 0.05), { [L]: 2.0e7 }), cash: noisy(5e8, 0), assets: noisy(8e9, 0), receivables: noisy(4e8, 0), equity: noisy(3e9, 0) }, events: [['2026-07-30', '4.02,8.01'], ['2026-08-12', '4.01']] },
  2009: { name: 'Albrecht Chemical Co (demo)', t: 'DMO.ACC', f: { revenue: noisy(2.8e9, 0.005), netIncome: noisy(2.2e8, 0.005, 0.1), opIncome: noisy(3.2e8, 0.005, 0.08), cash: at(noisy(1.2e9, 0.01), { [L]: 3.3e9 }), assets: noisy(1.6e10, 0.005), debt: at(noisy(3.9e9, 0), { [L]: 6.2e9 }), equity: noisy(6.4e9, 0.01) } },
  2010: { name: 'Pellucid Software (demo)', t: 'DMO.PSW', f: { revenue: noisy(9e8, 0.03), netIncome: noisy(9e7, 0.03, 0.15), opIncome: noisy(1.3e8, 0.03, 0.1), cash: noisy(2e9, 0.01), assets: noisy(6e9, 0.01), receivables: at(noisy(2.6e8, 0.03), { [L]: 6.3e8 }), equity: noisy(4e9, 0.01) } },
  2011: { name: 'Stillwater Energy (demo)', t: 'DMO.SWE', f: { revenue: noisy(5e9, 0.0, 0.08), netIncome: noisy(4e8, 0.0, 0.25), opIncome: noisy(6e8, 0, 0.15), cash: noisy(1.5e9, 0), assets: noisy(3e10, 0.002), debt: noisy(8e9, 0), equity: noisy(1.4e10, 0) } },
  2012: { name: 'Fairhaven Foods (demo)', t: 'DMO.FHF', noQ4: true, f: { revenue: noisy(1.9e9, 0.01, 0.02), netIncome: noisy(1.3e8, 0.01, 0.05), cash: noisy(4e8, 0), assets: noisy(7e9, 0.005), equity: noisy(3e9, 0.01) } },
};

const CONCEPT_BY_TAG = {}; for (const [ck, c] of Object.entries(DS.CONCEPTS)) CONCEPT_BY_TAG[c.tags[0]] = ck;
// pre-generate values so repeated frame calls agree
const V = {}; for (const [cik, c] of Object.entries(C)) { V[cik] = {}; for (const [ck, fn] of Object.entries(c.f)) { V[cik][ck] = {}; for (const q of qs.concat([qs[0] - 4, qs[0] - 3, qs[0] - 2, qs[0] - 1])) V[cik][ck][q] = Math.round(fn(q)); } }

async function fetchJson(url) {
  if (url.includes('company_tickers_exchange')) return { data: Object.entries(C).map(([cik, c]) => [+cik, c.name, c.t, 'NYSE']) };
  if (url.includes('/submissions/')) {
    const cik = String(+url.match(/CIK(\d+)/)[1]); const c = C[cik]; const ev = c.events || [];
    const acc = ev.map((_, i) => `0009${cik}-26-00000${i}`);
    return { sic: '0000', sicDescription: 'Fictional company (demo data)', filings: { recent: { accessionNumber: acc, filingDate: ev.map((e) => e[0]), form: ev.map(() => '8-K'), items: ev.map((e) => e[1]), primaryDocument: ev.map(() => 'demo.htm') } } };
  }
  const m = url.match(/us-gaap\/(\w+)\/USD\/CY(\d{4})(?:Q(\d))?(I?)\.json/); if (!m) return null;
  const [, tag, y, q, inst] = m; const ck = CONCEPT_BY_TAG[tag]; if (!ck) return null;
  const data = [];
  for (const [cik, c] of Object.entries(C)) {
    if (!V[cik][ck]) continue;
    if (!q) { if (!c.noQ4) continue; const vals = [1, 2, 3, 4].map((k) => V[cik][ck][qiOf(+y, k)]); if (vals.some((v) => v == null)) continue; data.push({ cik: +cik, entityName: c.name, accn: `DEMO-${y}-FY`, start: `${y}-01-01`, end: `${y}-12-31`, val: vals.reduce((a, b) => a + b, 0) }); continue; }
    const qi = qiOf(+y, +q); if (c.noQ4 && !inst && +q === 4) continue;
    const v = V[cik][ck][qi]; if (v == null) continue;
    data.push({ cik: +cik, entityName: c.name, accn: `DEMO-${qLabel(qi)}`, start: inst ? undefined : qStart(qi), end: qEnd(qi), val: v });
  }
  return { data };
}

(async () => {
  const res = await DS.runScan({ fetchJson, now: NOW, config: { minAssets: 1e9 } });
  res.meta.demo = true;
  res.meta.generatedAt = NOW.toISOString();
  // plausible "filing season" coverage figure for the latest quarter in the demo
  for (const f of res.flags) { f.firstSeen = f.cik % 3 === 0 ? '2026-10-27' : '2026-08-' + String(10 + (f.cik % 15)).padStart(2, '0'); for (const r of f.reasons) r.firstSeen = f.firstSeen; f.docUrl = null; }
  const out = path.join(__dirname, '..', 'docs', 'data', 'flags.json');
  fs.writeFileSync(out, JSON.stringify(res));
  console.log(`demo flags: ${res.flags.length}`); for (const f of res.flags) console.log(f.ticker, f.score, f.reasons.map((r) => r.label).join(' | '));
})();
