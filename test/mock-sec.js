// Offline end-to-end harness: replaces fetch with a fake SEC so scan.js can run with no network.
//   SEC_USER_AGENT="test t@example.com" node -r ./test/mock-sec.js scan.js
// 300 companies with 12 quarters of data; company 1000 has a cash collapse, company 1001 files a fresh 10-Q,
// company 1002 an 8-K earnings release, company 1003 (ticker SKHY) a foreign results 6-K.
const N = 300;
const ciks = Array.from({ length: N }, (_, i) => 1000 + i);
const rnd = (seed) => { let x = Math.sin(seed) * 1e4; return x - Math.floor(x); };
const now = new Date();
const iso = (d) => d.toISOString();
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const text = (s) => new Response(s, { status: 200 });
const qEnd = (y, q) => new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);

globalThis.fetch = async (url) => {
  url = String(url);
  if (url.endsWith('company_tickers_exchange.json')) {
    return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: ciks.map((c) => [c, `Company ${c} Inc.`, c === 1003 ? 'SKHY' : `T${c}`, c === 1003 ? 'Nasdaq' : 'NYSE']) });
  }
  let m = url.match(/frames\/us-gaap\/(\w+)\/USD\/CY(\d{4})(Q(\d))?(I?)\.json/);
  if (m) {
    const [, tag, y, , q] = m;
    if (!q) return json({ data: [] }); // no annual frames: no derived Q4 in this test
    const base = { Assets: 5e9, CashAndCashEquivalentsAtCarryingValue: 6e8, Revenues: 1.2e9, NetIncomeLoss: 9e7, OperatingIncomeLoss: 1.5e8, StockholdersEquity: 2e9, LongTermDebtNoncurrent: 1e9 }[tag];
    if (!base) return json({ data: [] });
    const qi = +y * 4 + +q;
    return json({ data: ciks.map((c) => {
      let val = base * (1 + 0.04 * rnd(c * 7 + qi) - 0.02 + 0.005 * (qi % 4));
      const latest = qi >= now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3); // most recent closed quarter
      if (c === 1000 && tag === 'CashAndCashEquivalentsAtCarryingValue' && latest) val = base * 0.1;
      return { cik: c, entityName: `Company ${c} Inc.`, val: Math.round(val), accn: c === 1001 && latest ? '0000001001-26-000001' : `000000${c}-26-0000${qi % 90}`, start: tag === 'Assets' || /Cash|Equity|Debt/.test(tag) ? undefined : qEnd(+y, +q - 1), end: qEnd(+y, +q) };
    }) });
  }
  if (/submissions\/CIK\d+\.json/.test(url)) {
    const cik = +url.match(/CIK(\d+)/)[1];
    return json({ sic: '3674', sicDescription: 'Semiconductors', tickers: [`T${cik}`], filings: { recent: { accessionNumber: [], form: [], filingDate: [], reportDate: [], acceptanceDateTime: [], items: [], primaryDocument: [] } } });
  }
  if (url.includes('browse-edgar')) {
    if (!/start=0&/.test(url)) return text('<feed></feed>');
    const type = decodeURIComponent(url.match(/type=([^&]+)/)[1]);
    const when = iso(new Date(Date.now() - 3 * 36e5));
    const entry = (form, cik, accn, items) => `<entry><title>${form} - Company ${cik} Inc. (${String(cik).padStart(10, '0')}) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/${cik}/${accn.replace(/-/g, '')}/${accn}-index.htm"/><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; ${when.slice(0, 10)} &lt;b&gt;AccNo:&lt;/b&gt; ${accn} ${items.map((i) => `&lt;br&gt;Item ${i}: x`).join('')}</summary><updated>${when}</updated></entry>`;
    const feeds = { '10-Q': entry('10-Q', 1001, '0000001001-26-000001', []), '8-K': entry('8-K', 1002, '0000001002-26-000002', ['2.02', '9.01']), '6-K': entry('6-K', 1003, '0000001003-26-000003', []) };
    return text(`<feed>${feeds[type] || ''}</feed>`);
  }
  if (url.endsWith('-index.htm')) {
    const cik = +url.match(/data\/(\d+)\//)[1];
    const doc = cik === 1003 ? ['6-K', 'FORM 6-K', 'res6k.htm'] : cik === 1002 ? ['EX-99.1', 'PRESS RELEASE', 'ex991.htm'] : ['10-Q', '10-Q', 'q.htm'];
    return text(`<table><tr><td>1</td><td>${doc[1]}</td><td><a href="/Archives/edgar/data/${cik}/x/${doc[2]}">${doc[2]}</a></td><td>${doc[0]}</td></tr></table>`);
  }
  if (url.endsWith('ex991.htm')) return text('<p>Company 1002 reported third quarter revenue of $1.31 billion, up 9% compared with the third quarter of 2025.</p><p>“We delivered a record quarter,” said Jane Doe, Chief Executive Officer of Company 1002.</p>');
  if (url.endsWith('res6k.htm')) return text('<p>Preliminary Results of Operations for the third quarter.</p><table><tr><td>Classification (unit : in millions of Won or %)</td><td>Current Period (Third quarter of 2026)</td><td>Previous Period (Second quarter of 2026)</td><td>Changes (%)</td></tr><tr><td>Revenue</td><td>104,615,483</td><td>79,318,746</td><td>31.9</td></tr></table>');
  if (url.endsWith('.htm')) return text('<p>Cash and cash equivalents were $60.0 million at the end of the third quarter of 2026.</p>');
  return new Response('not found', { status: 404 });
};
