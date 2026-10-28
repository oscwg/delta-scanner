/*
 * Delta Scanner — filings module.
 *  1. latestFilings(): reads EDGAR's live "latest filings" feed (updated within minutes) so the scan knows
 *     which 10-Q / 10-K / 8-K filings arrived overnight or this morning.
 *  2. corroborate(): pulls verbatim sentences from the filing behind each flag (10-Q / 10-K) and from the
 *     company's earnings release for the same quarter (8-K Item 2.02, Exhibit 99), plus any call transcript
 *     or prepared remarks the company filed as an exhibit. Every quote is validated before it is kept.
 *  3. justReported(): earnings releases filed in the last 48h by companies in the universe, whose
 *     XBRL numbers will only arrive with the 10-Q. Headline sentences are shown, validated the same way.
 *
 * Zero dependencies; runs in Node 18+ and in a browser. Network goes through injected fetchText(url).
 */
(function (root) {
  'use strict';
  const SEC = 'https://www.sec.gov';
  const DAY = 864e5;

  // ------------------------------------------------------------- latest-filings feed
  function parseAtom(xml) {
    const out = [];
    for (const e of xml.split('<entry>').slice(1)) {
      const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const m = title.match(/^(.*?) - (.*) \((\d{10})\) \((Filer|Subject|Reporting)\)/);
      if (!m) continue;
      const sum = decode((e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '');
      const items = [...sum.matchAll(/Item (\d\.\d\d)/g)].map((x) => x[1]);
      out.push({
        form: decode(m[1]).trim(), name: decode(m[2]).trim(), cik: +m[3], role: m[4],
        accn: (sum.match(/AccNo:<\/b>\s*([\d-]+)/) || [])[1] || (e.match(/accession-number=([\d-]+)/) || [])[1],
        filed: (sum.match(/Filed:<\/b>\s*([\d-]+)/) || [])[1],
        accepted: (e.match(/<updated>([^<]+)<\/updated>/) || [])[1],
        items,
        index: (e.match(/href="([^"]+-index\.htm)"/) || [])[1],
      });
    }
    return out;
  }

  // Pages through the feed for each form type until entries are older than `hours`.
  async function latestFilings({ fetchText, hours = 48, now = new Date(), forms = ['10-Q', '10-K', '8-K'], log = () => {} }) {
    const cutoff = +now - hours * 3600e3;
    const all = [];
    for (const type of forms) {
      for (let start = 0; start < 4000; start += 100) {
        const url = `${SEC}/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=${start}&count=100&output=atom`;
        let xml; try { xml = await fetchText(url); } catch (e) { log(`  ! feed ${type} @${start}: ${e.message}`); break; }
        const rows = parseAtom(xml || '');
        if (!rows.length) break;
        let older = false;
        for (const r of rows) {
          if (Date.parse(r.accepted) < cutoff) { older = true; continue; }
          if (r.role === 'Filer') all.push(r);
        }
        if (older) break;
      }
    }
    // keep the base form family only (10-Q/A etc. stay, they are amendments)
    const seen = new Set();
    const dedup = all.filter((r) => (seen.has(r.accn) ? false : seen.add(r.accn)));
    log(`Latest-filings feed: ${dedup.length} filings in the last ${hours}h (${forms.join(', ')}).`);
    return dedup;
  }

  // ------------------------------------------------------------- text extraction
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', reg: '®', trade: '™', copy: '©', bull: '•' };
  function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
      if (g[0] === '#') { const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return n === 160 ? ' ' : String.fromCodePoint(n); }
      return ENT[g.toLowerCase()] ?? m;
    });
  }
  function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<table[\s\S]*?<\/table>/gi, ' \n ')            // financial tables are not prose
      .replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    s = decode(s).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n');
    return s;
  }
  function sentences(text) {
    const out = [];
    for (const para of text.split('\n')) {
      const p = para.trim(); if (p.length < 40) continue;
      // split on sentence ends, protecting common abbreviations
      const safe = p.replace(/\b(Inc|Corp|Co|Ltd|Mr|Ms|Dr|No|U\.S|vs|approx|e\.g|i\.e)\./g, (m) => m.replace(/\./g, '§'))
        .replace(/(\s[A-Z])\.(?=\s[A-Z][a-z])/g, '$1§'); // middle initials ("Wendell P. Weeks")
      for (let s of safe.split(/(?<=[.!?][”"]?)\s+(?=[A-Z“"($])/)) {
        s = s.replace(/§/g, '.').trim();
        const words = s.split(/\s+/).length;
        if (words < 7 || words > 110) continue;
        const digits = (s.match(/\d/g) || []).length;
        if (digits / s.length > 0.25) continue;                           // table residue
        if (/forward-looking|safe harbor|risk factors|undue reliance/i.test(s)) continue;
        out.push(s);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- figures in prose
  const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9 };
  function moneyIn(s) {
    const out = [];
    const re = /\$\s*\(?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*\)?\s*(thousand|million|billion|bn|mn|m|b|k)?\b/gi;
    let m;
    while ((m = re.exec(s))) {
      const raw = m[1].replace(/,/g, ''); const dec = (raw.split('.')[1] || '').length;
      const scale = m[2] ? SCALE[m[2].toLowerCase()] : 1;
      out.push({ value: parseFloat(raw) * scale, tol: 0.5 * Math.pow(10, -dec) * scale, text: m[0].trim(), index: m.index });
    }
    return out;
  }
  function pctIn(s) {
    const out = []; const re = /(\d+(?:\.\d+)?)\s*(%|percent\b|percentage points?|pp\b|basis points|bps)/gi; let m;
    while ((m = re.exec(s))) {
      let v = parseFloat(m[1]); const unit = m[2].toLowerCase();
      if (unit.startsWith('basis') || unit === 'bps') v = v / 100;
      const dec = (m[1].split('.')[1] || '').length;
      out.push({ value: v, tol: Math.max(0.5 * Math.pow(10, -dec), 0.05), text: m[0], pp: /point|pp|basis|bps/.test(unit), index: m.index });
    }
    return out;
  }

  // ------------------------------------------------------------- what each rule should be corroborated by
  const TOPIC = {
    cashDrop: /cash and cash equivalents|cash position|liquidity|cash on hand|cash balance/i,
    cashSurge: /cash and cash equivalents|cash position|liquidity|proceeds|cash balance/i,
    niSwing: /net (income|loss|earnings)|net (loss|income) attributable|GAAP (net|earnings|diluted)/i,
    revenueShock: /revenues?|net sales|total sales/i,
    marginShift: /operating (income|loss|margin)|income from operations|loss from operations|impairment|restructuring/i,
    leverageJump: /notes|term loan|borrow|indebtedness|debt|credit facility|bonds/i,
    equityErosion: /stockholders[’']? equity|shareholders[’']? equity|repurchase|buyback|accumulated deficit|impairment/i,
    goodwillHit: /goodwill|impairment/i,
    receivables: /receivables?|days sales outstanding|DSO/i,
    inventory: /inventor(y|ies)/i,
    balanceSheet: /acqui|merger|divest|spin-off|spin off|completed the|combination/i,
  };
  const BOILER = /\b(excludes?|excluding|defined as|we define|non-GAAP|reconciliation|is calculated|are calculated|refer to|see note|in accordance with)\b/i;
  const MGMT = /\b(said|commented|stated|noted|added)\b.*\b(Chief|CEO|CFO|President|Chair)|\b(Chief Executive|Chief Financial|CEO|CFO)\b.*\b(said|commented|stated)\b|^“|^"/i;

  // Candidate figures a quote may confirm, for one reason of one flag.
  function targetsFor(flag, reason) {
    const s = flag.chart && flag.chart[reason.metric]; if (!s) return { money: [], pct: [] };
    const t = s.length - 1, lag = reason.basis === 'QoQ' ? 1 : 4;
    const v0 = s[t] && s[t][1], v1 = s[t - lag] && s[t - lag][1];
    const money = [[v0, 'current'], [v1, 'prior'], [v0 != null && v1 != null ? v0 - v1 : null, 'change']]
      .filter(([v]) => v != null && Math.abs(v) >= 1e6).map(([v, which]) => ({ value: Math.abs(v), which, period: which === 'current' ? s[t][0] : which === 'prior' ? s[t - lag][0] : null }));
    const pct = [];
    if (v0 != null && v1 != null && v1 !== 0) pct.push({ value: Math.abs((v0 - v1) / Math.abs(v1)) * 100, which: 'change' });
    if (reason.marginFrom != null) pct.push({ value: Math.abs(reason.marginTo * 100), which: 'current', period: s[t][0] }, { value: Math.abs(reason.marginFrom * 100), which: 'prior', period: s[t - lag] && s[t - lag][0] }, { value: Math.abs((reason.marginTo - reason.marginFrom) * 100), which: 'change' });
    return { money, pct };
  }

  const NONGAAP = /\b(adjusted|non-GAAP|core|comparable|pro forma|organic|underlying|normali[sz]ed)\b|EBITDA/i;
  const CHANGE = /increas|decreas|\brose\b|\bfell\b|\bgrew\b|growth|declin|\bup\b|\bdown\b|higher|lower|change|impairment|write-?(down|off)|reduc|swing|jump|surg|drop/i;
  // the clause a figure sits in: text since the previous ';', '•', sentence-internal ' and ' / ', ' break, at most 100 chars
  function clauseBefore(sent, index) {
    const pre = sent.slice(Math.max(0, index - 100), index);
    const cut = Math.max(pre.lastIndexOf(';'), pre.lastIndexOf('•'), pre.lastIndexOf(', '), pre.lastIndexOf(' and '));
    return cut >= 0 ? pre.slice(cut + 1) : pre;
  }
  function scoreSentence(sent, reason, targets) {
    if (!TOPIC[reason.rule] || !TOPIC[reason.rule].test(sent)) return null;
    let match = null;
    const money = moneyIn(sent), pcts = pctIn(sent);
    // the quoted figure must equal the flagged figure to the precision it was written with; the current quarter wins over the comparison
    // A figure only verifies when (a) it is not labelled adjusted / non-GAAP in its own clause, and (b) it equals the flagged
    // value to the precision written, capped at 5% so a round threshold ("exceeding $1 billion") cannot pass for $1.17bn.
    const gaapOk = (q) => !NONGAAP.test(clauseBefore(sent, q.index));
    // a figure matched against the size of the move must be described as a move, or coincidences pass ("$22.9bn remaining
    // buyback authorisation" is not a $22.9bn fall in equity)
    const asChange = (q) => CHANGE.test(clauseBefore(sent, q.index) + ' ' + sent.slice(q.index, q.index + 60));
    // the line item must be named next to the figure (or lead the sentence): "Corporate Unallocated expense decreased 41%"
    // in a sentence that mentions lease impairments elsewhere is not about a 41% fall in equity
    const firstFig = Math.min(...money.map((m) => m.index), ...pcts.map((m) => m.index));
    const topicNear = (q) => TOPIC[reason.rule].test(clauseBefore(sent, q.index) + ' ' + sent.slice(q.index, q.index + 60)) ||
      (q.index === firstFig && TOPIC[reason.rule].test(sent.replace(/^…\s*/, '').slice(0, 60))); // "Net income for the quarter … was $155m"
    const ok = (q, v) => gaapOk(q) && topicNear(q) && (v.which !== 'change' || asChange(q));
    outer: for (const v of targets.money) for (const q of money) {
      if (ok(q, v) && Math.abs(q.value - v.value) <= Math.max(Math.min(q.tol, 0.05 * v.value), 0.005 * v.value)) { match = { kind: 'money', quoted: q.text, value: v.value, which: v.which, period: v.period }; break outer; }
    }
    if (!match) outer2: for (const v of targets.pct) for (const q of pcts) {
      if (ok(q, v) && Math.abs(q.value - v.value) <= Math.max(q.tol, 0.6)) { match = { kind: 'pct', quoted: q.text, value: v.value, which: v.which, period: v.period }; break outer2; }
    }
    const mgmt = MGMT.test(sent);
    // without a matching figure a sentence is context at best. Management statements may be qualitative; anything else
    // must state a figure about the period that is at least a tenth of the flagged move, and must not be boilerplate.
    if (!match) {
      if (BOILER.test(sent)) return null;
      if (!mgmt) {
        if (!(money.length || pcts.length) || !/quarter|three months|period|year-over-year|year over year|compared/i.test(sent)) return null;
        const move = targets.money.find((v) => v.which === 'change');
        if (money.length && move && Math.max(...money.map((m) => m.value)) < 0.1 * move.value) return null;
      }
    }
    const score = (match ? 3 : 0) + 1 + (mgmt ? 1 : 0) + (/three months|quarter/i.test(sent) ? 0.3 : 0);
    return { score, match, mgmt };
  }

  // Keep quotes short: a long sentence is cut to a window around the matched figure, marked with ellipses.
  function trimQuote(s, anchor, maxWords = 42) {
    const w = s.split(/\s+/); if (w.length <= maxWords) return s;
    let at = anchor ? w.findIndex((x) => x.includes(anchor.split(/\s+/)[0])) : 0; if (at < 0) at = 0;
    const from = Math.max(0, Math.min(at - Math.floor(maxWords / 2), w.length - maxWords));
    return (from > 0 ? '… ' : '') + w.slice(from, from + maxWords).join(' ') + (from + maxWords < w.length ? ' …' : '');
  }

  // ------------------------------------------------------------- filing documents
  async function filingDocs(fetchText, cik, accn) {
    const url = `${SEC}/Archives/edgar/data/${+cik}/${accn.replace(/-/g, '')}/${accn}-index.htm`;
    const html = await fetchText(url);
    const docs = [];
    for (const tr of (html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map((c) => c);
      if (cells.length < 4) continue;
      const href = (cells[2].match(/href="([^"]+)"/) || [])[1]; if (!href) continue;
      docs.push({ desc: decode(cells[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), url: SEC + href.replace(/^\/ix\?doc=/, ''), type: decode(cells[3].replace(/<[^>]+>/g, '')).trim() });
    }
    return { index: url, docs };
  }
  const isTranscript = (d) => /^EX-99/.test(d.type) && /transcript|prepared[\s_-]*remarks|conference[\s_-]*call|earnings[\s_-]*call|script|commentary/i.test(d.desc + ' ' + d.url);
  // in an Item 2.02 8-K every other Exhibit 99 is the release or its financial supplement, whatever the file is called
  const isRelease = (d) => /^EX-99/.test(d.type) && !isTranscript(d);

  async function docSentences(fetchText, url, cache) {
    if (cache && cache.text && cache.text[url]) return cache.text[url];
    const html = await fetchText(url);
    const s = sentences(htmlToText(html || ''));
    if (cache) { cache.text = cache.text || {}; cache.text[url] = s; }
    return s;
  }

  // ------------------------------------------------------------- corroboration
  async function corroborate(flags, { fetchText, fetchJson, log = () => {}, max = 60, cache = {}, concurrency = 3 } = {}) {
    const todo = flags.filter((f) => f.accn).slice(0, max);
    log(`Corroborating ${todo.length} flags from their filings…`);
    let i = 0, done = 0;
    const work = async () => {
      while (i < todo.length) {
        const f = todo[i++];
        const key = `${f.accn}|${f.reasons.map((r) => r.rule).join(',')}`;
        if (cache.quotes && cache.quotes[key]) { f.corroboration = cache.quotes[key]; done++; continue; }
        try { f.corroboration = await corroborateOne(f, { fetchText, fetchJson }); }
        catch (e) { f.corroboration = { quotes: [], sources: [], error: e.message }; }
        cache.quotes = cache.quotes || {}; cache.quotes[key] = f.corroboration; done++;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, work));
    log(`Corroboration done: ${todo.filter((f) => f.corroboration && f.corroboration.quotes.length).length}/${todo.length} flags have validated statements.`);
    return cache;
  }

  async function corroborateOne(f, { fetchText, fetchJson }) {
    const sources = [];
    // 1. the periodic filing the numbers came from
    if (f.docUrl && /^10-[QK]/.test(f.form || '')) sources.push({ kind: f.form.startsWith('10-K') ? '10-K' : '10-Q', label: `${f.form} filed ${f.filed}`, url: f.docUrl });
    // 2. the earnings release (and any transcript) for the same quarter: 8-K Item 2.02 filed between period end and the 10-Q
    const sub = f._sub || (fetchJson ? await fetchJson(`https://data.sec.gov/submissions/CIK${String(f.cik).padStart(10, '0')}.json`) : null);
    const r = sub && sub.filings && sub.filings.recent;
    if (r) {
      const ai = r.accessionNumber.indexOf(f.accn);
      const periodEnd = ai >= 0 ? r.reportDate[ai] : null;
      const filed = f.filed || (ai >= 0 ? r.filingDate[ai] : null);
      if (periodEnd && filed) {
        const hi = new Date(+new Date(filed + 'T00:00:00Z') + 3 * DAY).toISOString().slice(0, 10);
        for (let k = 0; k < r.form.length; k++) {
          if (!/^8-K/.test(r.form[k]) || !/2\.02/.test(r.items[k] || '')) continue;
          if (r.filingDate[k] < periodEnd || r.filingDate[k] > hi) continue;
          const { docs } = await filingDocs(fetchText, f.cik, r.accessionNumber[k]);
          for (const d of docs.slice(0, 6)) {
            if (isTranscript(d)) sources.push({ kind: 'transcript', label: `Call transcript / remarks (8-K ${r.filingDate[k]}, ${d.type})`, url: d.url });
            else if (isRelease(d)) sources.push({ kind: 'release', label: `Earnings release (8-K ${r.filingDate[k]}, ${d.type})`, url: d.url });
          }
          break;
        }
      }
    }
    // 3. score every sentence of every source against every quantitative reason
    const reasons = f.reasons.filter((x) => x.rule !== 'event' && TOPIC[x.rule]);
    const cands = [];
    for (const src of sources.slice(0, 4)) {
      let sents; try { sents = await docSentences(fetchText, src.url); } catch (e) { src.error = e.message; continue; }
      src.sentences = sents.length;
      for (const reason of reasons.slice(0, 3)) {
        const targets = targetsFor(f, reason);
        for (const s of sents) {
          const sc = scoreSentence(s, reason, targets);
          if (sc) cands.push({ ...sc, sentence: s, reason: reason.rule, reasonLabel: reason.label, src });
        }
      }
    }
    // best quote per reason: prefer a figure match, then management voice, then the earnings release over the 10-Q
    const quotes = []; const used = new Set();
    for (const reason of reasons.slice(0, 3)) {
      const best = cands.filter((c) => c.reason === reason.rule && !used.has(c.sentence))
        .sort((a, b) => b.score - a.score || (b.src.kind === 'transcript') - (a.src.kind === 'transcript') || (b.src.kind === 'release') - (a.src.kind === 'release'))[0];
      if (!best) continue;
      if (!best.match && quotes.some((q) => q.verified)) continue;   // topic-only quotes are kept only when nothing verified exists
      used.add(best.sentence);
      quotes.push({
        reason: best.reason, reasonLabel: best.reasonLabel,
        text: trimQuote(best.sentence, best.match && best.match.quoted),
        verified: !!best.match, figure: best.match ? best.match.quoted : null, figureIs: best.match ? best.match.which : null, figurePeriod: best.match ? best.match.period || null : null, management: best.mgmt,
        source: best.src.label, sourceKind: best.src.kind, url: best.src.url,
      });
      if (quotes.length >= 3) break;
    }
    // management voice: the best on-topic comment from the earnings release or transcript, even without a figure
    if (!quotes.some((q) => q.management)) {
      const mg = cands.filter((c) => c.mgmt && c.src.kind !== '10-Q' && c.src.kind !== '10-K' && !used.has(c.sentence)).sort((a, b) => b.score - a.score)[0];
      if (mg) quotes.push({
        reason: mg.reason, reasonLabel: mg.reasonLabel, text: trimQuote(mg.sentence, mg.match && mg.match.quoted),
        verified: !!mg.match, figure: mg.match ? mg.match.quoted : null, figureIs: mg.match ? mg.match.which : null, figurePeriod: mg.match ? mg.match.period || null : null, management: true,
        source: mg.src.label, sourceKind: mg.src.kind, url: mg.src.url,
      });
    }
    return { quotes, sources: sources.map(({ kind, label, url, sentences: n, error }) => ({ kind, label, url, sentences: n || 0, error })) };
  }

  // ------------------------------------------------------------- earnings releases waiting for their 10-Q
  async function justReported(latest, universe, { fetchText, log = () => {}, max = 40, flaggedCiks = new Set() } = {}) {
    const releases = latest.filter((x) => /^8-K/.test(x.form) && x.items.includes('2.02') && universe[x.cik]);
    // skip companies whose 10-Q/10-K for the quarter is already in the feed: they are scored normally
    const periodic = new Set(latest.filter((x) => /^10-[QK]/.test(x.form)).map((x) => x.cik));
    const todo = releases.filter((x) => !periodic.has(x.cik)).sort((a, b) => (universe[b.cik].size || 0) - (universe[a.cik].size || 0)).slice(0, max);
    log(`Earnings releases awaiting a 10-Q: ${todo.length}.`);
    const out = [];
    for (const x of todo) {
      const u = universe[x.cik];
      const item = { cik: x.cik, ticker: u.ticker, name: u.name, tier: u.tier, accepted: x.accepted, filed: x.filed, index: x.index && (x.index.startsWith('http') ? x.index : SEC + x.index), flagged: flaggedCiks.has(x.cik), headlines: [] };
      try {
        const { docs } = await filingDocs(fetchText, x.cik, x.accn);
        const tr = docs.find(isTranscript);
        const rel = docs.find(isRelease) || tr;
        if (rel) {
          if (rel === tr) item.headlineSource = 'transcript'; else item.releaseUrl = rel.url;
          const sents = await docSentences(fetchText, rel.url);
          // headline results: revenue / net income / EPS sentences that state a figure; first ones in the document win
          const picked = [];
          for (const s of sents) {
            if (!/revenue|net sales|net (income|loss)|earnings per share|EPS|operating (income|loss)/i.test(s)) continue;
            if (/^\(?\d{1,2}\)\s|^\d{1,2}\s/.test(s)) continue; // footnotes are not headlines
            if (!moneyIn(s).length && !pctIn(s).length) continue;
            if (picked.some((p) => p.slice(0, 60) === s.slice(0, 60))) continue;
            picked.push(s); if (picked.length >= 2) break;
          }
          const mg = sents.find((s) => MGMT.test(s) && s.split(/\s+/).length <= 70);
          item.headlines = picked.map((s) => ({ text: trimQuote(s), management: MGMT.test(s), url: rel.url }));
          if (mg && !picked.includes(mg)) item.headlines.push({ text: trimQuote(mg), management: true, url: rel.url });
        }
        if (tr) item.transcriptUrl = tr.url;
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
    return out;
  }

  // ------------------------------------------------------------- foreign issuers' results (6-K), unscored
  // Foreign private issuers report on IFRS in their own currency, so the US-GAAP frames never score them. For a
  // watchlist of large foreign listings, results 6-Ks from the feed are shown with their own results table, verbatim.
  const RESULT_ROW = /^(total )?(revenues?|net sales|sales|operating (profit|income|loss)|profit \(loss\) for the period|profit for the period|net (income|profit|loss)|profit from continuing operations|income before income tax|attributable to:? (controlling|owners))/i;
  function firstLine(cellHtml) {
    return decode(String(cellHtml).replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')).split('\n').map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim()).find(Boolean) || '';
  }
  function resultsTable(html) {
    const rows = [];
    let header = null, unit = null;
    for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const raw = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      const full = raw.map((c) => decode(c.replace(/<[^>]+>/g, ' ')).replace(/[\s\u00a0]+/g, ' ').replace(/\s*\(\d\)\s*/g, ' ').trim()).filter(Boolean);
      if (!header && full.length >= 3 && /current period|three months ended|quarter/i.test(full.slice(1).join(' '))) {
        header = full; const u = full[0].match(/\((?:unit\s*:?\s*)?in ([^)]+)\)/i); if (u) unit = u[1]; continue;
      }
      let cells = raw.map(firstLine).filter((c) => c && c !== '*' && c !== ')' && c !== '%' && c !== '$');
      cells = cells.map((c) => (/^\(\d[\d.,]*$/.test(c) ? c + ')' : c));
      if (!cells.length) continue;
      if (RESULT_ROW.test(cells[0]) && cells.slice(1).some((c) => /\d/.test(c))) rows.push(cells.filter((c, i) => i === 0 || !/^(quarterly|ytd|year-to-date)/i.test(c)));
    }
    // without identified column headers the columns cannot be labelled (quarter vs year-to-date), so show nothing
    if (!header || !rows.length) return null;
    const seen = new Set();
    return { header, unit, rows: rows.filter((r) => (seen.has(r.join('|')) ? false : seen.add(r.join('|')))).slice(0, 6) };
  }
  async function foreignResults(latest, watch, { fetchText, log = () => {} } = {}) {
    const todo = latest.filter((x) => /^6-K/.test(x.form) && watch[x.cik]);
    const out = [];
    for (const x of todo) {
      try {
        const { docs } = await filingDocs(fetchText, x.cik, x.accn);
        for (const d of docs.filter((d) => /^(6-K|EX-99)/.test(d.type)).slice(0, 4)) {
          const html = await fetchText(d.url);
          const text = htmlToText(html || '');
          if (!/results of operations|earnings release|financial results|quarterly results|preliminary results/i.test(text)) continue;
          const table = resultsTable(html);
          const sents = sentences(text).filter((s) => /revenue|sales|operating (profit|income)|net (income|profit)|profit/i.test(s) && (moneyIn(s).length || pctIn(s).length || /\b(won|KRW|yen|euro|EUR|NT\$|trillion|billion)\b/i.test(s))).slice(0, 2);
          if (!table && !sents.length) continue;
          const w = watch[x.cik];
          out.push({ cik: x.cik, ticker: w.ticker, name: w.name || x.name, tier: w.tier || null, accepted: x.accepted, filed: x.filed, form: x.form, foreign: true,
            index: x.index && (x.index.startsWith('http') ? x.index : SEC + x.index), releaseUrl: d.url, figures: table,
            headlines: sents.map((s) => ({ text: trimQuote(s), management: MGMT.test(s), url: d.url })) });
          break;
        }
      } catch (e) { log(`  ! 6-K ${x.accn}: ${e.message}`); }
    }
    // one card per company: keep the filing with the richest content
    const rich = (j) => (j.figures ? 1000 : 0) + j.headlines.reduce((n, h) => n + h.text.length, 0);
    const best = new Map();
    for (const j of out) if (!best.has(j.cik) || rich(j) > rich(best.get(j.cik))) best.set(j.cik, j);
    const res = [...best.values()].filter((j) => j.figures || j.headlines.length);
    log(`Foreign-issuer results (6-K): ${res.length}.`);
    return res;
  }

  const api = { latestFilings, corroborate, corroborateOne, justReported, foreignResults, resultsTable, parseAtom, htmlToText, sentences, moneyIn, pctIn, scoreSentence, targetsFor, trimQuote, filingDocs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DeltaFilings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
