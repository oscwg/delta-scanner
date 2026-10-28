/*
 * Delta Scanner engine — finds sudden shifts in US-listed companies' reported financials.
 *
 * Source: SEC EDGAR XBRL "frames" API (one line item, one calendar quarter, every filer)
 * plus the Submissions API for 8-K event codes on flagged names. Free, no API key.
 *
 * Zero dependencies. Runs unchanged in Node 18+ (see scan.js) and in a browser.
 * All network access goes through the injected fetchJson(url) so the caller owns
 * rate limiting, the SEC-required User-Agent, retries and caching.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- config
  const DEFAULTS = {
    quarters: 12,              // calendar quarters of history pulled per line item
    minAssets: 1e9,            // universe: total assets >= $1bn ...
    minRevenueTTM: 5e8,        // ... or trailing-4Q revenue >= $500m
    exchanges: ['NYSE', 'Nasdaq', 'CBOE'],
    maxStaleQuarters: 1,       // drop companies whose latest filing is older than this
    eventLookbackDays: 150,    // 8-K window for the event overlay
    maxFlags: 250,
    concurrency: 6,
    minAbsDelta: 25e6,         // ignore moves smaller than $25m outright
    watchlist: [],             // tickers always scanned regardless of size
    minZ: 3,                   // a move must sit >= 3 robust SDs outside the company's own YoY history...
    minZFlip: 2,               // ...or >= 2 for a profit/loss sign flip (rules skip the test when history is too short)
    minMarginPP: 0.15,         // operating-margin shift, in fraction points
  };

  const CONCEPTS = {
    revenue:     { kind: 'duration', label: 'Revenue', tags: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
    netIncome:   { kind: 'duration', label: 'Net income', tags: ['NetIncomeLoss'] },
    opIncome:    { kind: 'duration', label: 'Operating income', tags: ['OperatingIncomeLoss'] },
    cash:        { kind: 'instant',  label: 'Cash & equivalents', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
    assets:      { kind: 'instant',  label: 'Total assets', tags: ['Assets'] },
    debt:        { kind: 'instant',  label: 'Long-term debt', tags: ['LongTermDebtNoncurrent', 'LongTermDebt'] },
    equity:      { kind: 'instant',  label: "Shareholders' equity", tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
    receivables: { kind: 'instant',  label: 'Receivables', tags: ['AccountsReceivableNetCurrent'] },
    inventory:   { kind: 'instant',  label: 'Inventory', tags: ['InventoryNet'] },
    goodwill:    { kind: 'instant',  label: 'Goodwill', tags: ['Goodwill'] },
  };

  const EIGHT_K = {
    '1.01': ['Entered material agreement', 1], '1.02': ['Terminated material agreement', 2],
    '1.03': ['Bankruptcy or receivership', 12], '2.01': ['Completed acquisition/disposal', 3],
    '2.02': ['Results of operations', 0], '2.03': ['New material financial obligation', 3],
    '2.04': ['Obligation accelerated (trigger event)', 12], '2.05': ['Exit / restructuring costs', 6],
    '2.06': ['Material impairment', 6], '3.01': ['Delisting / listing-rule notice', 12],
    '4.01': ['Auditor change', 8], '4.02': ['Non-reliance on prior financials (restatement)', 12],
    '5.02': ['Director / officer change', 2], '5.03': ['Charter / bylaw amendment', 0],
    '7.01': ['Reg FD disclosure', 0], '8.01': ['Other events', 0], '9.01': ['Exhibits', 0],
  };

  const RULES = {
    cashDrop:      { label: 'Liquidity shock', group: 'Balance sheet' },
    cashSurge:     { label: 'Cash surge', group: 'Balance sheet' },
    niSwing:       { label: 'Earnings swing', group: 'P&L' },
    revenueShock:  { label: 'Revenue shock', group: 'P&L' },
    marginShift:   { label: 'Margin shift', group: 'P&L' },
    leverageJump:  { label: 'Leverage jump', group: 'Balance sheet' },
    equityErosion: { label: 'Equity erosion', group: 'Balance sheet' },
    goodwillHit:   { label: 'Goodwill write-down', group: 'Balance sheet' },
    receivables:   { label: 'Receivables stretch', group: 'Quality' },
    inventory:     { label: 'Inventory build', group: 'Quality' },
    balanceSheet:  { label: 'Balance-sheet transformation', group: 'Structure' },
  };

  const FUND_RE = /\b(ETF|ETN|Fund|Bitcoin Trust|Ether(eum)? Trust|Gold Trust|Silver Trust|Metals? (Basket )?Trust|Commodity|Bond Trust)\b/i;

  // ---------------------------------------------------------------- periods
  const qiOf = (y, q) => y * 4 + (q - 1);
  const qLabel = (qi) => `${Math.floor(qi / 4)}Q${(qi % 4) + 1}`;
  const framePeriod = (qi, instant) => `CY${Math.floor(qi / 4)}Q${(qi % 4) + 1}${instant ? 'I' : ''}`;
  const qiOfDate = (d) => qiOf(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) + 1);
  const DAY = 864e5;
  const parseDate = (s) => new Date(s + 'T00:00:00Z');

  function latestClosedQuarter(now) {
    // the calendar quarter that ended most recently before `now`
    return qiOfDate(now) - 1;
  }

  // ---------------------------------------------------------------- helpers
  const pct = (a, b) => (b == null || a == null || b === 0 ? null : (a - b) / Math.abs(b));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function money(v) {
    if (v == null || !isFinite(v)) return 'n/a';
    const a = Math.abs(v), sign = v < 0 ? '−' : '';
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}bn`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    return `${sign}$${Math.round(a / 1e3)}k`;
  }
  function pctText(p) {
    if (p == null || !isFinite(p)) return 'n/a';
    const a = Math.abs(p * 100);
    const num = a >= 1000 ? Math.round(a).toLocaleString('en-GB') : a.toFixed(a < 10 ? 1 : 0);
    return `${p > 0 ? '+' : p < 0 ? '−' : ''}${num}%`;
  }
  const pctAbs = (p) => pctText(p == null ? p : Math.abs(p)).replace('+', '');
  const ppText = (d) => `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)}pp`;
  const pc1 = (x) => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`;
  const share = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    });
    await Promise.all(workers);
    return out;
  }

  // Robust z-score of the latest YoY change against the company's own history of YoY changes.
  function robustZ(series, t, floor) {
    const diffs = [];
    for (let q = t - 1; q >= t - 8; q--) {
      const a = series.get(q), b = series.get(q - 4);
      if (a && b) diffs.push(a.val - b.val);
    }
    const a = series.get(t), b = series.get(t - 4);
    if (!a || !b || diffs.length < 4) return null;
    const med = median(diffs);
    const mad = median(diffs.map((d) => Math.abs(d - med)));
    const scale = Math.max(1.4826 * mad, floor);
    return (a.val - b.val - med) / scale;
  }

  // ---------------------------------------------------------------- ingest
  async function ingest(cfg, fetchJson, log, now) {
    const tEnd = latestClosedQuarter(now);
    const tStart = tEnd - cfg.quarters + 1;
    const window = []; for (let q = tStart; q <= tEnd; q++) window.push(q);
    const years = [...new Set(window.map((q) => Math.floor(q / 4)))].filter((y) => qiOf(y, 4) < tEnd + 1);

    const jobs = [];
    for (const [ck, c] of Object.entries(CONCEPTS)) {
      for (const tag of c.tags) {
        for (const q of window) jobs.push({ ck, tag, period: framePeriod(q, c.kind === 'instant'), qi: q, annual: false });
        if (c.kind === 'duration') for (const y of years) jobs.push({ ck, tag, period: `CY${y}`, qi: null, annual: true });
      }
    }
    log(`Fetching ${jobs.length} XBRL frames (${qLabel(tStart)}–${qLabel(tEnd)})…`);

    const raw = {};       // raw[ck][tag][cik] = Map(qi -> rec)
    const annual = {};    // annual[tag][cik] = [rec]
    const names = {};
    let done = 0, missing = 0;
    await pool(jobs, cfg.concurrency, async (j) => {
      const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${j.tag}/USD/${j.period}.json`;
      let js = null;
      try { js = await fetchJson(url); } catch (e) { log(`  ! ${j.tag} ${j.period}: ${e.message}`); }
      done++; if (done % 25 === 0) log(`  ${done}/${jobs.length} frames`);
      if (!js || !Array.isArray(js.data)) { missing++; return; }
      for (const r of js.data) {
        const cik = r.cik;
        names[cik] = names[cik] || r.entityName;
        const rec = { val: r.val, accn: r.accn, start: r.start || null, end: r.end };
        if (j.annual) {
          ((annual[j.tag] = annual[j.tag] || {})[cik] = annual[j.tag][cik] || []).push(rec);
        } else {
          const byTag = ((raw[j.ck] = raw[j.ck] || {})[j.tag] = raw[j.ck][j.tag] || {});
          (byTag[cik] = byTag[cik] || new Map()).set(j.qi, rec);
        }
      }
    });
    log(`Frames done (${missing} empty or unavailable).`);

    // Derive fiscal Q4 for duration tags: annual minus the three reported quarters.
    let derivedCount = 0;
    for (const [ck, c] of Object.entries(CONCEPTS)) {
      if (c.kind !== 'duration') continue;
      for (const tag of c.tags) {
        const byTag = (raw[ck] && raw[ck][tag]) || {};
        const ann = annual[tag] || {};
        for (const [cik, facts] of Object.entries(ann)) {
          const qs = byTag[cik]; if (!qs) continue;
          for (const a of facts) {
            if (!a.start) continue;
            const aS = parseDate(a.start), aE = parseDate(a.end);
            const len = (aE - aS) / DAY; if (len < 340 || len > 390) continue;
            const inside = [...qs.values()].filter((r) => r.start && parseDate(r.start) >= aS - 6 * DAY && parseDate(r.end) <= +aE + 6 * DAY);
            if (inside.length !== 3) continue;
            const lastEnd = Math.max(...inside.map((r) => +parseDate(r.end)));
            if ((aE - lastEnd) / DAY < 70) continue; // the missing quarter is not the last one
            const mid = new Date((lastEnd + DAY + +aE) / 2);
            const qi = qiOfDate(mid);
            if (qi < tStart || qi > tEnd || qs.has(qi)) continue;
            const dv = a.val - inside.reduce((s, r) => s + r.val, 0);
            if (ck === 'revenue' && dv < 0) continue; // negative revenue means the annual and quarterly facts don't line up
            qs.set(qi, { val: dv, accn: a.accn, start: new Date(lastEnd + DAY).toISOString().slice(0, 10), end: a.end, derived: true });
            derivedCount++;
          }
        }
      }
    }
    log(`Derived ${derivedCount} fiscal-Q4 values from annual filings.`);

    // Pick one tag per company per concept (most coverage, then priority) so series stay consistent.
    const series = {}; // series[cik][ck] = Map(qi -> rec), plus .__tags
    for (const [ck, c] of Object.entries(CONCEPTS)) {
      const byTag = raw[ck] || {};
      const ciks = new Set(); for (const t of c.tags) for (const k of Object.keys(byTag[t] || {})) ciks.add(k);
      for (const cik of ciks) {
        let best = null, bestN = -1;
        for (const t of c.tags) {
          const m = byTag[t] && byTag[t][cik]; const n = m ? m.size : 0;
          if (n > bestN) { best = t; bestN = n; }
        }
        if (!best || bestN <= 0) continue;
        const s = (series[cik] = series[cik] || { __tags: {} });
        s[ck] = byTag[best][cik]; s.__tags[ck] = best;
      }
    }
    return { series, names, window, tStart, tEnd, derivedCount, framesFetched: jobs.length - missing, framesRequested: jobs.length };
  }

  // ---------------------------------------------------------------- rules
  function evaluate(cik, s, t, cfg) {
    const get = (ck, q) => { const m = s[ck]; const r = m && m.get(q); return r ? r.val : undefined; };
    const has = (ck, q) => get(ck, q) !== undefined;
    const A = get('assets', t) ?? get('assets', t - 1);
    if (!A || A <= 0) return [];
    const revQ = get('revenue', t);
    const out = [];

    const zFor = (ck) => (s[ck] ? robustZ(s[ck], t, 0.005 * A) : null);
    // severity: 25% size of % move, 25% materiality, 50% how far outside the company's own history (z)
    const zPart = (z) => (z == null ? 0.3 : Math.min(1, Math.max(0, Math.log2(Math.abs(z) / 2) / 3))); // z 4 → .33, 8 → .67, 16 → 1
    // Base effect: the latest quarter is in line with the three before it, so the YoY move comes from an
    // unusual year-ago quarter (e.g. a one-off charge), not from anything new. Those are skipped.
    const recentMedian = (ck) => { const xs = [1, 2, 3].map((k) => get(ck, t - k)).filter((v) => v !== undefined); return xs.length >= 2 ? median(xs) : undefined; };
    const baseEffect = (v0, vy, recent) => recent !== undefined && Math.abs(v0 - recent) < 0.35 * Math.abs(v0 - vy);
    const skip = (rule) => { out.skipped = (out.skipped || 0) + 1; return rule; };
    const sev = (pctMove, mat, z) => clamp(100 * (0.25 * Math.min(1, Math.abs(pctMove || 0) / 1.5) + 0.25 * Math.min(1, mat / 0.2) + 0.5 * zPart(z)), 0, 100);
    const anomalous = (z, min) => z == null || Math.abs(z) >= (min == null ? cfg.minZ : min);
    const scaleErr = (a, b) => { if (!a || !b) return false; const r = Math.abs(a / b); return (r > 900 && r < 1100) || (r > 1 / 1100 && r < 1 / 900); };
    const zText = (z) => (z != null && Math.abs(z) >= 2.5 ? ` That is ${Math.abs(z) > 10 ? 'more than 10' : Math.abs(z).toFixed(1)}σ outside its own 8-quarter pattern of YoY changes.` : '');
    const derivedNote = (ck, q) => (s[ck] && s[ck].get(q) && s[ck].get(q).derived ? ' (fiscal Q4 derived as annual minus 9 months)' : '');

    function compare(ck, minDropOrRise, dir) {
      // returns the stronger of YoY / QoQ comparisons that satisfies the threshold
      const v0 = get(ck, t); if (v0 === undefined) return null;
      const opts = [];
      for (const [lag, basis] of [[4, 'year-on-year'], [1, 'quarter-on-quarter']]) {
        const v1 = get(ck, t - lag); if (v1 === undefined) continue;
        const p = pct(v0, v1); if (p == null) continue;
        if ((dir < 0 && p <= minDropOrRise[lag]) || (dir > 0 && p >= minDropOrRise[lag])) opts.push({ v0, v1, p, lag, basis, delta: v0 - v1 });
      }
      if (!opts.length) return null;
      opts.sort((a, b) => Math.abs(b.p) - Math.abs(a.p));
      const o = opts[0];
      if (Math.abs(o.delta) < cfg.minAbsDelta) return null;
      return o;
    }

    function push(rule, metric, severity, text, o, extra) {
      const r = { rule, label: RULES[rule].label, group: RULES[rule].group, metric, severity: Math.round(severity), text, basis: o ? (o.lag === 1 ? 'QoQ' : 'YoY') : 'YoY', from: o ? o.v1 : null, to: o ? o.v0 : null, change: o ? o.p : null };
      if (o && scaleErr(o.v0, o.v1)) { r.severity = Math.round(r.severity * 0.3); r.dataWarning = 'Values differ by ~1000×: possible XBRL scaling error in the filing.'; }
      Object.assign(r, extra || {});
      out.push(r);
    }

    // context sentences reused by several rules
    const yoyOf = (ck) => pct(get(ck, t), get(ck, t - 4));
    const assetsYoY = yoyOf('assets');
    const mnaHint = assetsYoY != null && Math.abs(assetsYoY) >= 0.4 ? ` Total assets also moved ${pctText(assetsYoY)} YoY, so M&A or a disposal may explain part of this.` : '';

    // 1. Liquidity shock
    {
      const o = compare('cash', { 4: -0.4, 1: -0.35 }, -1);
      const zc = zFor('cash');
      if (o && Math.abs(o.delta) / A >= 0.05 && (o.lag === 1 || anomalous(zc))) {
        const z = zc; const mat = Math.abs(o.delta) / A;
        let ctx = '';
        const dDebt = get('debt', t) !== undefined && get('debt', t - o.lag) !== undefined ? get('debt', t) - get('debt', t - o.lag) : null;
        if (dDebt != null && dDebt < 0 && -dDebt >= 0.4 * -o.delta) ctx = ` Long-term debt fell ${money(-dDebt)} over the same period, so a repayment may account for much of it.`;
        else if (dDebt != null && dDebt > 0.5 * -o.delta) ctx = ` Long-term debt rose ${money(dDebt)} at the same time, so the cash went out despite new borrowing.`;
        push('cashDrop', 'cash', sev(o.p, mat, z), `Cash & equivalents fell ${pctAbs(o.p)} ${o.basis} (${money(o.v1)} → ${money(o.v0)}), a drawdown equal to ${share(mat)} of total assets.${zText(z)}${ctx}${mnaHint}`, o, { z, materiality: mat });
      }
    }
    // 2. Cash surge
    {
      const o = compare('cash', { 4: 1.0, 1: 0.75 }, 1);
      const zc = zFor('cash');
      if (o && o.delta / A >= 0.05 && (o.lag === 1 || anomalous(zc))) {
        const z = zFor('cash'); const mat = o.delta / A;
        const dDebt = get('debt', t) !== undefined && get('debt', t - o.lag) !== undefined ? get('debt', t) - get('debt', t - o.lag) : null;
        const dEq = get('equity', t) !== undefined && get('equity', t - o.lag) !== undefined ? get('equity', t) - get('equity', t - o.lag) : null;
        let ctx = '';
        if (dDebt != null && dDebt >= 0.5 * o.delta) ctx = ` Long-term debt rose ${money(dDebt)} alongside, so this looks debt-funded.`;
        else if (dEq != null && dEq >= 0.5 * o.delta) ctx = ` Equity rose ${money(dEq)} alongside, consistent with a share issue, asset sale or strong earnings.`;
        push('cashSurge', 'cash', 0.8 * sev(Math.min(o.p, 1), mat, z), `Cash & equivalents rose ${pctAbs(o.p)} ${o.basis} (${money(o.v1)} → ${money(o.v0)}), adding ${share(mat)} of total assets.${zText(z)}${ctx}`, o, { z, materiality: mat });
      }
    }
    // 3. Earnings swing (net income)
    {
      const n0 = get('netIncome', t), ny = get('netIncome', t - 4);
      if (n0 !== undefined && ny !== undefined) {
        const d = n0 - ny; const scale = Math.max(Math.abs(revQ || 0), 0.02 * A);
        const mat = Math.abs(d) / scale; const z = zFor('netIncome');
        const o = { v0: n0, v1: ny, p: pct(n0, ny), lag: 4, basis: 'year-on-year', delta: d };
        const base = revQ ? `${share(Math.abs(d) / Math.abs(revQ))} of quarterly revenue` : `${share(Math.abs(d) / A)} of total assets`;
        const be = baseEffect(n0, ny, recentMedian('netIncome'));
        if (be) skip('niSwing');
        else if (n0 * ny < 0 && Math.abs(d) >= cfg.minAbsDelta && mat >= 0.08 && anomalous(z, cfg.minZFlip)) {
          const toLoss = n0 < 0;
          push('niSwing', 'netIncome', clamp(35 + 25 * Math.min(1, mat / 0.5) + 40 * zPart(z), 0, 100),
            `Net income swung from a ${money(Math.abs(ny))} ${ny < 0 ? 'loss' : 'profit'} to a ${money(Math.abs(n0))} ${toLoss ? 'loss' : 'profit'} versus the same quarter last year${derivedNote('netIncome', t)}. The ${money(Math.abs(d))} swing equals ${base}.${zText(z)}${mnaHint}`,
            o, { z, materiality: mat, label: toLoss ? 'Swung to loss' : 'Swung to profit', direction: toLoss ? 'down' : 'up' });
        } else if (n0 * ny > 0 && Math.abs(d) >= Math.max(cfg.minAbsDelta, 50e6) && mat >= 0.05 && (o.p >= 1.0 || o.p <= -0.6) && anomalous(z)) {
          const up = d > 0; const losses = n0 < 0;
          push('niSwing', 'netIncome', sev(Math.min(Math.abs(o.p), 1), mat, z),
            `${losses ? `Net loss ${up ? 'narrowed' : 'widened'} from ${money(-ny)} to ${money(-n0)} year-on-year` : `Net income ${up ? 'surged' : 'collapsed'} ${pctAbs(o.p)} year-on-year (${money(ny)} → ${money(n0)})`}${derivedNote('netIncome', t)}; the ${money(Math.abs(d))} move equals ${base}.${zText(z)}${mnaHint}`,
            o, { z, materiality: mat, label: losses ? (up ? 'Loss narrowed' : 'Loss widened') : up ? 'Earnings surge' : 'Earnings collapse', direction: up ? 'up' : 'down' });
        }
      }
    }
    // 4. Revenue shock
    {
      const r0 = get('revenue', t), ry = get('revenue', t - 4);
      if (r0 !== undefined && ry !== undefined && Math.max(r0, ry) >= 1e8) {
        const p = pct(r0, ry); const d = r0 - ry; const z = zFor('revenue');
        if (p != null && (p <= -0.2 || p >= 0.5) && baseEffect(r0, ry, recentMedian('revenue'))) skip('revenueShock');
        else if (p != null && (p <= -0.2 || p >= 0.5) && Math.abs(d) >= Math.max(cfg.minAbsDelta, 50e6) && anomalous(z)) {
          const o = { v0: r0, v1: ry, p, lag: 4, basis: 'year-on-year', delta: d };
          const up = d > 0;
          push('revenueShock', 'revenue', sev(Math.min(Math.abs(p), 1), Math.abs(d) / A, z),
            `Quarterly revenue ${up ? 'jumped' : 'dropped'} ${pctAbs(p)} year-on-year (${money(ry)} → ${money(r0)})${derivedNote('revenue', t)}.${zText(z)}${up ? mnaHint : ''}`,
            o, { z, materiality: Math.abs(d) / A, label: up ? 'Revenue surge' : 'Revenue drop', direction: up ? 'up' : 'down' });
        }
      }
    }
    // 5. Operating margin shift
    {
      const r0 = get('revenue', t), ry = get('revenue', t - 4), p0 = get('opIncome', t), py = get('opIncome', t - 4);
      if ([r0, ry, p0, py].every((v) => v !== undefined) && r0 >= 1e8 && ry >= 1e8) {
        const m0 = p0 / r0, my = py / ry, d = m0 - my;
        const zo = zFor('opIncome');
        const rm = [1, 2, 3].map((k) => (get('revenue', t - k) > 0 && get('opIncome', t - k) !== undefined ? get('opIncome', t - k) / get('revenue', t - k) : undefined)).filter((v) => v !== undefined);
        const marginBase = rm.length >= 2 && Math.abs(m0 - median(rm)) < 0.35 * Math.abs(d);
        if (marginBase && Math.abs(d) >= cfg.minMarginPP) skip('marginShift');
        else if (Math.abs(d) >= cfg.minMarginPP && Math.abs(p0 - py) >= cfg.minAbsDelta && Math.abs(p0 - py) / A >= 0.01 && Math.abs(m0) < 3 && Math.abs(my) < 3 && anomalous(zo, 2.5)) {
          push('marginShift', 'opIncome', clamp(25 + 35 * Math.min(1, Math.abs(d) / 0.5) + 40 * zPart(zo), 0, 100),
            `Operating margin moved from ${pc1(my)} to ${pc1(m0)} (${ppText(d)}) year-on-year; operating income went ${money(py)} → ${money(p0)} on revenue of ${money(r0)}.`,
            { v0: p0, v1: py, p: pct(p0, py), lag: 4, delta: p0 - py }, { z: zo, label: d > 0 ? 'Margin expansion' : 'Margin compression', direction: d > 0 ? 'up' : 'down', marginFrom: my, marginTo: m0 });
        }
      }
    }
    // 6. Leverage jump
    {
      const o = compare('debt', { 4: 0.5, 1: 0.35 }, 1);
      const zd = zFor('debt');
      if (o && o.delta / A >= 0.05 && (o.lag === 1 || anomalous(zd))) {
        const z = zFor('debt'); const mat = o.delta / A;
        const dCash = get('cash', t) !== undefined && get('cash', t - o.lag) !== undefined ? get('cash', t) - get('cash', t - o.lag) : null;
        const dAssets = get('assets', t) - (get('assets', t - o.lag) ?? get('assets', t));
        let ctx = '';
        if (dAssets >= 0.7 * o.delta) ctx = ` Total assets grew ${money(dAssets)} in parallel, pointing to debt-funded acquisitions or capex.`;
        else if (dCash != null && dCash >= 0.7 * o.delta) ctx = ` The proceeds largely sit in cash for now (+${money(dCash)}).`;
        else ctx = ' Neither cash nor total assets rose by a similar amount, so the borrowing is not obviously funding growth.';
        push('leverageJump', 'debt', sev(Math.min(o.p, 1), mat, z), `Long-term debt rose ${pctAbs(o.p)} ${o.basis} (${money(o.v1)} → ${money(o.v0)}), adding leverage equal to ${share(mat)} of total assets.${zText(z)}${ctx}`, o, { z, materiality: mat });
      }
    }
    // 7. Equity erosion
    {
      const e0 = get('equity', t), ey = get('equity', t - 4);
      if (e0 !== undefined && ey !== undefined) {
        const d = e0 - ey;
        if (e0 < 0 && ey > 0 && Math.abs(d) >= cfg.minAbsDelta) {
          push('equityErosion', 'equity', 80, `Shareholders' equity turned negative: ${money(ey)} a year ago → ${money(e0)} now. Liabilities now exceed assets on the reported balance sheet (this can also reflect large buybacks).`, { v0: e0, v1: ey, p: pct(e0, ey), lag: 4, delta: d }, { label: 'Equity turned negative', direction: 'down' });
        } else if (ey > 0 && pct(e0, ey) <= -0.3 && -d / A >= 0.05 && -d >= cfg.minAbsDelta && anomalous(zFor('equity'))) {
          const z = zFor('equity');
          push('equityErosion', 'equity', sev(pct(e0, ey), -d / A, z), `Shareholders' equity fell ${pctAbs(pct(e0, ey))} year-on-year (${money(ey)} → ${money(e0)}), an erosion equal to ${share(-d / A)} of total assets.${zText(z)}`, { v0: e0, v1: ey, p: pct(e0, ey), lag: 4, delta: d }, { z, materiality: -d / A, direction: 'down' });
        }
      }
    }
    // 8. Goodwill write-down (QoQ)
    {
      const g0 = get('goodwill', t), gq = get('goodwill', t - 1);
      if (g0 !== undefined && gq !== undefined && gq > 0) {
        const p = pct(g0, gq), d = g0 - gq;
        if (p <= -0.2 && -d / A >= 0.02 && -d >= cfg.minAbsDelta) {
          const n0 = get('netIncome', t);
          const ctx = n0 !== undefined && n0 < 0 ? ` The quarter also shows a net loss of ${money(-n0)}, consistent with an impairment charge.` : ' Check whether this is an impairment or a divestment.';
          push('goodwillHit', 'goodwill', clamp(45 + 35 * Math.min(1, -p) + 20 * Math.min(1, -d / A / 0.1), 0, 100), `Goodwill fell ${pctAbs(p)} in a single quarter (${money(gq)} → ${money(g0)}), a ${money(-d)} reduction equal to ${share(-d / A)} of total assets.${ctx}`, { v0: g0, v1: gq, p, lag: 1, delta: d }, { direction: 'down' });
        }
      }
    }
    // 9 & 10. Working-capital quality
    for (const [ck, rule, gap, noun] of [['receivables', 'receivables', 0.3, 'Receivables'], ['inventory', 'inventory', 0.4, 'Inventory']]) {
      const x0 = get(ck, t), xy = get(ck, t - 4), r0 = get('revenue', t), ry = get('revenue', t - 4);
      if ([x0, xy, r0, ry].some((v) => v === undefined) || ry < 1e8 || xy <= 0) continue;
      const px = pct(x0, xy), pr = pct(r0, ry);
      const zx = zFor(ck);
      if (px - pr >= gap && (x0 - xy) / A >= 0.02 && x0 - xy >= cfg.minAbsDelta && anomalous(zx)) {
        push(rule, ck, sev(px - pr, (x0 - xy) / A, zx),
          `${noun} ${px >= 0 ? 'grew ' + pctAbs(px) : 'fell only ' + pctAbs(px)} year-on-year (${money(xy)} → ${money(x0)}) while quarterly revenue moved ${pctText(pr)}. ${ck === 'receivables' ? 'Collections may be slowing, or revenue is being recognised ahead of cash.' : 'Stock is building faster than sales, a common precursor to write-downs or discounting.'}${mnaHint}`,
          { v0: x0, v1: xy, p: px, lag: 4, delta: x0 - xy }, { z: zx, materiality: (x0 - xy) / A, direction: 'up', revenueChange: pr });
      }
    }
    // 11. Balance-sheet transformation
    {
      const a0 = get('assets', t), ay = get('assets', t - 4);
      if (a0 !== undefined && ay !== undefined) {
        const p = pct(a0, ay), d = a0 - ay;
        if ((p >= 0.6 || p <= -0.35) && Math.abs(d) >= 1e9) {
          push('balanceSheet', 'assets', 0.6 * sev(Math.min(Math.abs(p), 1), Math.abs(p), null), `Total assets ${d > 0 ? 'grew' : 'shrank'} ${pctAbs(p)} year-on-year (${money(ay)} → ${money(a0)}). A change this size usually means an acquisition, disposal, spin-off or capital raise; other flags for this company may be partly mechanical.`, { v0: a0, v1: ay, p, lag: 4, delta: d }, { direction: d > 0 ? 'up' : 'down' });
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- events (8-K overlay)
  async function enrich(flags, cfg, fetchJson, log, now) {
    log(`Fetching filing history for ${flags.length} flagged companies…`);
    const cutoff = +now - cfg.eventLookbackDays * DAY;
    await pool(flags, cfg.concurrency, async (f) => {
      let js = null;
      try { js = await fetchJson(`https://data.sec.gov/submissions/CIK${String(f.cik).padStart(10, '0')}.json`); } catch (e) { /* keep going */ }
      if (!js) return;
      Object.defineProperty(f, '_sub', { value: js, enumerable: false, configurable: true });
      f.sic = js.sic || null; f.industry = js.sicDescription || null;
      if (!f.ticker && js.tickers && js.tickers.length) f.ticker = js.tickers[0];
      const r = js.filings && js.filings.recent; if (!r) return;
      const accnIdx = new Map(r.accessionNumber.map((a, i) => [a, i]));
      if (f.accn && accnIdx.has(f.accn)) { const i = accnIdx.get(f.accn); f.filed = r.filingDate[i]; f.form = r.form[i]; if (r.acceptanceDateTime) f.acceptedAt = r.acceptanceDateTime[i];
        if (/^DEF 14/.test(f.form)) { f.confidence = 'Low'; f.confidenceNote = 'The annual figure behind a derived fiscal Q4 was tagged in a proxy statement (pay-versus-performance table), not the 10-K. Check it against the annual report.'; }
        else if (/^(6-K|20-F|40-F)/.test(f.form) && f.confidence === 'High') { f.confidence = 'Medium'; f.confidenceNote = 'Foreign private issuer: reports less often and not always on US GAAP quarterly tags.'; } if (r.primaryDocument[i]) f.docUrl = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accn.replace(/-/g, '')}/${r.primaryDocument[i]}`; }
      const events = [];
      for (let i = 0; i < r.form.length; i++) {
        if (!/^8-K/.test(r.form[i])) continue;
        if (+parseDate(r.filingDate[i]) < cutoff) continue;
        const items = String(r.items[i] || '').split(',').map((x) => x.trim()).filter(Boolean);
        const notable = items.filter((it) => EIGHT_K[it] && EIGHT_K[it][1] > 0);
        if (!notable.length) continue;
        events.push({ date: r.filingDate[i], items: notable.map((it) => ({ code: it, label: EIGHT_K[it][0], weight: EIGHT_K[it][1] })), url: `https://www.sec.gov/Archives/edgar/data/${f.cik}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i] || ''}` });
      }
      f.events = events;
      const codes = new Set(events.flatMap((e) => e.items.map((x) => x.code)));
      const boost = Math.min(15, [...codes].reduce((s, c) => s + EIGHT_K[c][1], 0));
      f.eventBoost = boost; f.score = Math.round(Math.min(99, f.score + boost * (1 - f.score / 100) * 2));
      // corroboration notes
      const rules = new Set(f.reasons.map((x) => x.rule));
      const note = (code, text) => { if (codes.has(code)) { const e = events.find((ev) => ev.items.some((x) => x.code === code)); f.reasons.push({ rule: 'event', label: `8-K Item ${code}`, group: 'Event', severity: EIGHT_K[code][1] * 5, text: `${text} (8-K filed ${e.date}).`, url: e.url }); } };
      note('4.02', 'The company told investors prior financial statements should no longer be relied upon, so a restatement is in play');
      note('1.03', 'Bankruptcy or receivership disclosed');
      note('2.04', 'A triggering event accelerated or increased a financial obligation');
      note('3.01', 'The exchange notified the company of a listing-standard failure or delisting');
      note('4.01', 'The company changed its auditor');
      note('2.06', rules.has('goodwillHit') ? 'A material impairment 8-K corroborates the goodwill reduction' : 'A material impairment was disclosed');
      note('2.05', 'Exit or restructuring costs were disclosed');
      if (rules.has('balanceSheet') || rules.has('leverageJump')) note('2.01', 'A completed acquisition or disposal was disclosed, which likely explains the balance-sheet move');
    });
  }

  // ---------------------------------------------------------------- main
  async function runScan(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const fetchJson = opts.fetchJson; const log = opts.log || (() => {}); const now = opts.now || new Date();
    const started = Date.now();

    // listing map (ticker + exchange)
    let listing = opts.tickers || null;
    if (!listing) {
      try {
        const tj = await fetchJson('https://www.sec.gov/files/company_tickers_exchange.json');
        listing = {};
        for (const row of tj.data) { const [cik, name, ticker, exchange] = row; if (!listing[cik]) listing[cik] = { name, ticker, exchange }; }
      } catch (e) { log(`Ticker map unavailable (${e.message}); universe will not be filtered by exchange.`); listing = null; }
    }

    const ing = opts.ingested || await ingest(cfg, fetchJson, log, now);
    if (opts.onIngested) opts.onIngested(ing);
    const { series, names, tEnd } = ing;
    const watch = new Set(cfg.watchlist.map((x) => x.toUpperCase()));

    let scanned = 0, baseSkipped = 0; const flags = []; const universe = {};
    const ruleCounts = {}; const coverage = {};
    const fresh = opts.fresh || {}; // cik -> { form, accn, accepted } from the latest-filings feed
    for (const q of ing.window) coverage[qLabel(q)] = 0;
    for (const [cikStr, s] of Object.entries(series)) {
      const cik = +cikStr; const L = listing ? listing[cik] : null;
      if (listing && !L) continue;
      if (L && cfg.exchanges.length && !cfg.exchanges.includes(L.exchange) && !watch.has(L.ticker)) continue;
      if (FUND_RE.test((L && L.name) || names[cik] || '') && !(L && watch.has(L.ticker))) continue; // ETFs, trusts and funds are not operating companies
      // current quarter = latest with assets or revenue
      let t = null;
      for (let q = tEnd; q >= tEnd - cfg.maxStaleQuarters; q--) if ((s.assets && s.assets.has(q)) || (s.revenue && s.revenue.has(q))) { t = q; break; }
      if (t == null) continue;
      const A = s.assets && (s.assets.get(t) || s.assets.get(t - 1));
      let ttm = 0, n = 0; for (let q = t; q > t - 4; q--) { const r = s.revenue && s.revenue.get(q); if (r) { ttm += r.val; n++; } }
      if (n < 4) ttm = n ? (ttm * 4) / n : 0;
      const big = (A && A.val >= cfg.minAssets) || ttm >= cfg.minRevenueTTM;
      if (!big && !(L && watch.has(L.ticker))) continue;
      scanned++;
      const tierOf = (A && A.val >= 5e10) || ttm >= 2e10 ? 'Mega' : (A && A.val >= 1e10) || ttm >= 5e9 ? 'Large' : (A && A.val >= 2e9) || ttm >= 1e9 ? 'Mid' : 'Small';
      universe[cik] = { ticker: L ? L.ticker : null, name: (L && L.name) || names[cik], tier: tierOf, size: Math.max(A ? A.val : 0, ttm) };
      if (s.assets) for (const q of ing.window) if (s.assets.has(q)) coverage[qLabel(q)]++;

      const reasons = evaluate(cik, s, t, cfg);
      baseSkipped += reasons.skipped || 0;
      if (!reasons.length) continue;
      reasons.sort((a, b) => b.severity - a.severity);
      // probabilistic-OR: the strongest signal counts fully, each corroborating one adds a damped share
      const score = 100 * (1 - (1 - reasons[0].severity / 100) * reasons.slice(1).reduce((x, r) => x * (1 - 0.35 * r.severity / 100), 1));
      for (const r of reasons) ruleCounts[r.rule] = (ruleCounts[r.rule] || 0) + 1;

      // series for charts: every metric that appears in reasons, plus core context lines
      const keep = new Set(['revenue', 'netIncome', 'cash', ...reasons.map((r) => r.metric)]);
      const chart = {};
      for (const ck of keep) {
        const m = s[ck]; if (!m) continue;
        chart[ck] = ing.window.filter((q) => q <= t).map((q) => { const r = m.get(q); return r ? [qLabel(q), r.val, r.derived ? 1 : 0] : [qLabel(q), null, 0]; });
      }
      const primaryMetric = reasons[0].metric;
      const srcRec = s[primaryMetric] && s[primaryMetric].get(t);
      const anyDerived = reasons.some((r) => s[r.metric] && s[r.metric].get(t) && s[r.metric].get(t).derived);
      const anyWarn = reasons.some((r) => r.dataWarning);
      const noHistory = reasons[0].z === undefined ? false : reasons[0].z == null && reasons[0].rule !== 'balanceSheet';
      flags.push({
        cik, ticker: L ? L.ticker : null, exchange: L ? L.exchange : null, name: (L && L.name) || names[cik],
        period: qLabel(t), assets: A ? A.val : null, revenueTTM: ttm || null,
        tier: tierOf,
        fresh: fresh[cik] && reasons.some((r) => s[r.metric] && s[r.metric].get(t) && s[r.metric].get(t).accn === fresh[cik].accn) ? { form: fresh[cik].form, accepted: fresh[cik].accepted } : undefined,
        score: Math.round(score), primary: reasons[0].rule, reasons, chart, tags: s.__tags,
        accn: srcRec ? srcRec.accn : null,
        confidence: anyWarn ? 'Low' : anyDerived || noHistory ? 'Medium' : 'High',
        confidenceNote: anyWarn ? 'Possible XBRL scaling error in source data.' : anyDerived ? 'Includes a fiscal-Q4 value derived from the annual report.' : noHistory ? 'Too little history to test the move against the company\'s own pattern.' : 'Directly reported quarterly XBRL values.',
      });
    }
    flags.sort((a, b) => b.score - a.score);
    const top = flags.slice(0, cfg.maxFlags);
    for (const f of flags.slice(cfg.maxFlags)) if (f.fresh) top.push(f); // anything filed in the last day or two is always kept
    if (opts.events !== false) await enrich(top, cfg, fetchJson, log, now);
    top.sort((a, b) => b.score - a.score);
    for (const f of top) f.reasons.sort((a, b) => (a.rule === 'event') - (b.rule === 'event') || b.severity - a.severity);

    log(`Scanned ${scanned} companies; ${flags.length} flagged; kept top ${top.length}.`);
    return {
      meta: {
        generatedAt: new Date().toISOString(), runSeconds: Math.round((Date.now() - started) / 1000),
        window: [qLabel(ing.tStart), qLabel(tEnd)], latestQuarter: qLabel(tEnd),
        companiesScanned: scanned, companiesFlagged: flags.length, flagsKept: top.length,
        baseEffectsSkipped: baseSkipped, framesFetched: ing.framesFetched, framesRequested: ing.framesRequested, derivedQ4: ing.derivedCount,
        coverage, ruleCounts, rules: RULES, concepts: Object.fromEntries(Object.entries(CONCEPTS).map(([k, c]) => [k, { label: c.label, kind: c.kind, tags: c.tags }])),
        config: { minAssets: cfg.minAssets, minRevenueTTM: cfg.minRevenueTTM, exchanges: cfg.exchanges, minAbsDelta: cfg.minAbsDelta, eventLookbackDays: cfg.eventLookbackDays },
        source: 'SEC EDGAR XBRL frames API + Submissions API (data.sec.gov)',
      },
      flags: top,
      universe,
    };
  }

  const api = { runScan, evaluate, robustZ, CONCEPTS, RULES, EIGHT_K, DEFAULTS, _internal: { qiOf, qLabel, framePeriod, latestClosedQuarter, money, pctText } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DeltaScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
