#!/usr/bin/env node
/*
 * Expands a compact snapshot payload (built in a browser session against SEC EDGAR, where this
 * container cannot reach sec.gov) into docs/data/flags.json in the dashboard's format.
 * Usage: node tools/expand-snapshot.js <payload.json> <out.json> [feed.json]
 * The scheduled GitHub Actions run does not use this: scan.js writes the full format directly.
 */
const fs = require('fs');
const path = require('path');
const DS = require('../engine.js');
const F = require('../filings.js');

const [, , inPath, outPath, feedPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: expand-snapshot.js <payload.json> <out.json> [feed.json]'); process.exit(1); }
const P = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const feed = feedPath ? JSON.parse(fs.readFileSync(feedPath, 'utf8')) : null;

// Incremental payloads: flags unchanged since the base snapshot arrive as `keep` ([cik, score, events, eventReasons, fresh])
// and are rebuilt from the base payload (BASE env var), which already carries their charts and verified quotes.
if (P.keep && P.keep.length) {
  const base = JSON.parse(fs.readFileSync(process.env.BASE, 'utf8'));
  const byCik = new Map(base.flags.map((f) => [f.c, f]));
  for (const [cik, score, ev, evReasons, fr] of P.keep) {
    const b = byCik.get(cik); if (!b) throw new Error(`keep ${cik}: not in base payload`);
    P.flags.push({ ...b, s: score, ev, fr, rs: b.rs.filter((r) => r[0] !== 'event').concat(evReasons) });
  }
  if (P.order) { const pos = new Map(P.order.map((c, i) => [c, i])); P.flags.sort((a, b) => pos.get(a.c) - pos.get(b.c)); }
}
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/data/flags.json'), 'utf8')); } catch (e) { return null; } })();

const SEC = 'https://www.sec.gov/Archives/edgar/data/';
const url = (s) => (s ? (s.startsWith('http') ? s : SEC + s) : null);
const M = (v) => (v == null ? null : Math.round(v * 1e6));
const CONF = { H: 'High', M: 'Medium', L: 'Low' };
const TRANSCRIPT_RE = /transcript|prepared[\s_-]*remarks|conference[\s_-]*call|earnings[\s_-]*call|script|commentary/i;
const WARN = 'Values differ by ~1000×: possible XBRL scaling error in the filing.';

function quarters(q0, n) {
  let [y, q] = [+q0.slice(0, 4), +q0.slice(5)];
  const out = [];
  for (let i = 0; i < n; i++) { out.push(`${y}Q${q}`); q++; if (q > 4) { q = 1; y++; } }
  return out;
}

const flags = P.flags.map((c) => {
  const chart = {};
  for (const [metric, arr] of Object.entries(c.h)) {
    const qs = quarters(c.q0, arr.length);
    if (qs[qs.length - 1] !== c.q1) throw new Error(`${c.t} ${metric}: ${arr.length} values do not end at ${c.q1}`);
    chart[metric] = arr.map((v, i) => (Array.isArray(v) ? [qs[i], M(v[0]), 1] : [qs[i], M(v), 0]));
  }
  const reasons = c.rs.map(([rule, label, severity, basis, metric, z, materiality, text, u, warn, margin]) => {
    const r = { rule, label, group: rule === 'event' ? 'Event' : (DS.RULES[rule] || {}).group, severity, basis, metric, z, materiality, text };
    if (u) r.url = url(u);
    if (warn) r.dataWarning = WARN;
    if (margin) { r.marginFrom = margin[0]; r.marginTo = margin[1]; }
    return r;
  });
  const events = (c.ev || []).map(([date, codes, u]) => ({
    date, url: url(u),
    items: codes.split(',').map((code) => ({ code, label: (DS.EIGHT_K[code] || ['Item ' + code])[0], weight: (DS.EIGHT_K[code] || [0, 0])[1] })),
  }));
  let corroboration;
  if (c.cq || c.cs) {
    corroboration = {
      quotes: (c.cq || []).map(([reasonLabel, text, verified, figure, figureIs, figurePeriod, management, source, sourceKind, u]) => ({
        reasonLabel, text, verified: !!verified, figure, figureIs, figurePeriod, management: !!management, source, sourceKind, url: url(u),
      })),
      sources: (c.cs || []).map(([kind, label, u, n]) => ({ kind, label, url: url(u), sentences: n })),
    };
    if (!corroboration.sources.length) corroboration.error = 'the flagged figure came from a filing that is not a 10-Q or 10-K, and no earnings release was found for the period';
  }
  const old = prev && prev.flags.find((f) => f.cik === c.c && f.period === c.p);
  return {
    cik: c.c, ticker: c.t, exchange: c.x, name: c.n, period: c.p,
    assets: M(c.a), revenueTTM: M(c.r), tier: c.tr, score: c.s,
    primary: (reasons.find((r) => r.rule !== 'event') || reasons[0]).rule,
    reasons, chart, tags: c.g, accn: c.ac, filed: c.fs, form: c.fm, docUrl: url(`${c.c}/${c.d}`),
    acceptedAt: c.at, fresh: c.fr ? { form: c.fr[0], accepted: c.fr[1] } : undefined,
    industry: c.ind, sic: c.sic, confidence: CONF[c.cf] || c.cf, confidenceNote: c.cn,
    firstSeen: (old && old.firstSeen) || (c.fr ? P.meta.generatedAt.slice(0, 10) : null),
    events, corroboration,
  };
});

// Re-apply the current validation rules to every stored quote (the payload was built with an earlier rule set).
let downgraded = 0, dropped = 0;
for (const f of flags) {
  if (!f.corroboration) continue;
  f.corroboration.quotes = f.corroboration.quotes.filter((q) => {
    const r = f.reasons.find((x) => x.label === q.reasonLabel && x.rule !== 'event');
    if (!r) return true;
    const res = F.scoreSentence(q.text.replace(/…/g, ' '), r, F.targetsFor(f, r));
    if (!res) { dropped++; console.log(`  drop ${f.ticker}: ${q.text.slice(0, 70)}`); return false; }
    if (q.verified && !res.match) { downgraded++; console.log(`  context-only ${f.ticker}: ${q.figure}`); }
    q.reason = r.rule; q.verified = !!res.match; q.figure = res.match ? res.match.quoted : null;
    q.figureIs = res.match ? res.match.which : null; q.figurePeriod = res.match ? res.match.period || null : null;
    return true;
  });
}
console.log(`re-validated quotes: ${downgraded} downgraded to context, ${dropped} dropped`);

const flaggedCiks = new Set(flags.map((f) => f.cik));
const justReported = (P.just || []).map(([cik, ticker, name, tier, accepted, filed, index, hl, rel, tr, hsrc]) => {
  const j = { cik, ticker, name, tier, accepted, filed, index: url(index), flagged: flaggedCiks.has(cik), releaseUrl: url(rel), transcriptUrl: url(tr) };
  if (hsrc) j.headlineSource = hsrc;
  // an Exhibit 99 that is the call transcript itself is labelled as such, not as the release
  if (j.releaseUrl && TRANSCRIPT_RE.test(j.releaseUrl)) { j.transcriptUrl = j.transcriptUrl || j.releaseUrl; j.releaseUrl = null; j.headlineSource = 'transcript'; }
  const src = j.releaseUrl || j.transcriptUrl;
  // footnote lines ("(1) Q3 growth rates impacted by…") are not headlines
  j.headlines = hl.filter(([text]) => !/^\(?\d{1,2}\)\s/.test(text)).map(([text, mg]) => ({ text, management: !!mg, url: src }));
  return j;
});

// foreign issuers' results 6-Ks (IFRS, own currency): shown with their results table as filed
const foreign = (P.fx || []).map(([cik, ticker, name, accepted, filed, form, index, rel, figures, hl]) => ({
  cik, ticker, name, tier: null, accepted, filed, form, foreign: true, index: url(index), releaseUrl: url(rel), flagged: false, figures,
  headlines: (hl || []).map(([text, mg]) => ({ text, management: !!mg, url: url(rel) })),
}));
justReported.unshift(...foreign);
justReported.sort((a, b) => Date.parse(b.accepted) - Date.parse(a.accepted));
const fresh = flags.filter((f) => f.fresh).length;
const topN = P.snap && P.snap.top != null ? P.snap.top : 38; // payload order: fresh, then the top N by score, then samples
const sampled = Math.max(0, flags.length - fresh - topN);
const meta = {
  ...P.meta,
  rules: prev ? prev.meta.rules : undefined,
  concepts: prev ? prev.meta.concepts : undefined,
  config: prev ? prev.meta.config : undefined,
  source: 'SEC EDGAR: XBRL frames API, Submissions API, latest-filings feed and filing documents (sec.gov)',
  snapshot: { shown: flags.length, fresh, top: flags.length - fresh - sampled, sampled, rankedOf: P.meta.flagsKept },
  transcriptsFound: justReported.filter((j) => j.transcriptUrl).length + flags.filter((f) => f.corroboration && f.corroboration.sources.some((s) => s.kind === 'transcript')).length,
};
if (feed) { meta.latestFeed = { hours: feed.hours, filings: feed.filings, periodic: feed.periodic, releases: feed.releases, checkedAt: feed.checkedAt }; meta.feedOldest = feed.oldest; }

fs.writeFileSync(outPath, JSON.stringify({ meta, flags, justReported }));
console.log(`wrote ${outPath}: ${flags.length} flags (${fresh} fresh, ${sampled} sampled), ${justReported.length} just reported, ${flags.filter((f) => f.corroboration && f.corroboration.quotes.some((q) => q.verified)).length} with a verified quote`);
