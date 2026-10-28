// Offline tests for the filings module: feed parsing, text extraction, figure matching and validation.
const assert = require('assert');
const F = require('../filings.js');

// 1. EDGAR latest-filings Atom entry (shape copied from the live feed)
const atom = `<?xml version="1.0"?><feed><entry>
<title>10-Q - Travel &amp; Leisure Co. (0001361658) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1361658/000136165826000064/0001361658-26-000064-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-10-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001361658-26-000064 &lt;b&gt;Size:&lt;/b&gt; 15 MB
</summary>
<updated>2026-10-27T10:39:23-04:00</updated>
<id>urn:tag:sec.gov,2008:accession-number=0001361658-26-000064</id>
</entry><entry>
<title>8-K - Example Corp (0000000001) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-10-27 &lt;b&gt;AccNo:&lt;/b&gt; 0000000001-26-000001 &lt;b&gt;Size:&lt;/b&gt; 1 MB
&lt;br&gt;Item 2.02: Results of Operations and Financial Condition
&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
<updated>2026-10-27T07:01:00-04:00</updated></entry></feed>`;
const rows = F.parseAtom(atom);
assert.strictEqual(rows.length, 2);
assert.deepStrictEqual([rows[0].form, rows[0].name, rows[0].cik, rows[0].accn, rows[0].filed], ['10-Q', 'Travel & Leisure Co.', 1361658, '0001361658-26-000064', '2026-10-27']);
assert.deepStrictEqual(rows[1].items, ['2.02', '9.01']);

// 2. HTML → prose: tables, hidden iXBRL header and boilerplate are dropped
const html = `<html><body><ix:header><div>hidden facts 123</div></ix:header>
<p>Gilead Sciences, Inc. announced its results for the second quarter 2026. Net loss was $10,496 million for the second quarter of 2026, compared to net income of $1,960 million for the same period in 2025.</p>
<table><tr><td>Revenue</td><td>7,803</td></tr></table>
<p>“We delivered another strong quarter,” said Daniel O’Day, Chairman and Chief Executive Officer, Gilead Sciences.</p>
<p>This press release includes forward-looking statements within the meaning of the Private Securities Litigation Reform Act.</p></body></html>`;
const sents = F.sentences(F.htmlToText(html));
assert(sents.some((s) => s.startsWith('Net loss was $10,496 million')), 'prose sentence kept');
assert(!sents.some((s) => /7,803|hidden facts|forward-looking/.test(s)), 'tables, ix header, boilerplate dropped');

// 3. figure parsing and precision-aware matching
const m = F.moneyIn('a loss of $10.5 billion and $1,960 million and $(827) million and $2.0 billion');
assert.deepStrictEqual(m.map((x) => x.value), [10.5e9, 1960e6, 827e6, 2.0e9]);
const flag = { chart: { netIncome: [['2025Q2', 1960e6, 0], ['2025Q3', 3052e6, 0], ['2025Q4', 2183e6, 1], ['2026Q1', 2021e6, 0], ['2026Q2', -10496e6, 0]] } };
const reason = { rule: 'niSwing', metric: 'netIncome', basis: 'YoY' };
const T = F.targetsFor(flag, reason);
const good = F.scoreSentence('Net loss was $10,496 million for the second quarter of 2026, compared to net income of $1,960 million.', reason, T);
assert(good && good.match && good.match.kind === 'money' && good.match.which === 'current' && good.match.quoted === '$10,496 million', 'current-quarter figure preferred');
const rounded = F.scoreSentence('The company reported a net loss of $10.5 billion for the quarter.', reason, T);
assert(rounded && rounded.match, 'rounded figure within its stated precision verified');
const wrong = F.scoreSentence('The company reported a net loss of $9.2 billion for the quarter.', reason, T);
assert(wrong && !wrong.match, 'a different figure is not verified');
const boiler = F.scoreSentence('Net income excludes discontinued operations as defined in the reconciliation for the quarter of $3 million.', reason, T);
assert.strictEqual(boiler, null, 'boilerplate without a matching figure rejected');
const tiny = F.scoreSentence('Net loss for the quarter included a $2.0 million gain on disposal compared to the prior year.', reason, T);
assert.strictEqual(tiny, null, 'immaterial context figure rejected');
const qual = F.scoreSentence('“Net loss this quarter reflects deliberate investment in our pipeline,” said the Chief Executive Officer.', reason, T);
assert(qual && !qual.match && qual.mgmt, 'qualitative management statement kept as context');
const offTopic = F.scoreSentence('Revenue was $7.8 billion for the quarter, up 10%.', reason, T);
assert.strictEqual(offTopic, null, 'off-topic sentence rejected for a net income flag');
const mgmt = F.scoreSentence('“Net loss reflects $10.5 billion of acquired IPR&D,” said the Chief Financial Officer.', reason, T);
assert(mgmt.mgmt && mgmt.match, 'management statement detected');

// 4. long quotes are cut around the figure
const long = 'In the second quarter we ' + 'continued to execute on our strategy across every part of the business '.repeat(6) + 'and net loss was $10.5 billion driven by charges.';
const tq = F.trimQuote(long, '$10.5');
assert(tq.split(/\s+/).length <= 44 && tq.includes('$10.5') && tq.startsWith('…'));

// 5. middle initials do not end a sentence
const ini = F.sentences('Wendell P. Weeks, chairman and chief executive officer, said, “We delivered an outstanding third quarter for every one of our businesses.”');
assert.strictEqual(ini.length, 1, 'middle initial kept inside the sentence');
assert(ini[0].startsWith('Wendell P. Weeks'));

// 6. adjusted / non-GAAP figures and round thresholds never verify a GAAP flag
const fr = { chart: { netIncome: [['2025Q3', 40e6, 0], ['2025Q4', 50e6, 0], ['2026Q1', 60e6, 0], ['2026Q2', -15e6, 0], ['2026Q3', 111.0e6, 0]], revenue: [['2025Q3', 742.7e6, 0], ['2025Q4', 800e6, 0], ['2026Q1', 900e6, 0], ['2026Q2', 937e6, 0], ['2026Q3', 1167.9e6, 0]] } };
const rNI = { rule: 'niSwing', metric: 'netIncome', basis: 'YoY' }, rRev = { rule: 'revenueShock', metric: 'revenue', basis: 'YoY' };
const adj = F.scoreSentence('Adjusted Net Income was $111.1 million in the third quarter of 2026, compared to $46.3 million in the prior-year period.', rNI, F.targetsFor(fr, rNI));
assert(!adj || !adj.match, 'adjusted net income does not verify GAAP net income');
const gaap = F.scoreSentence('Net income was $111.0 million in the third quarter of 2026, while adjusted net income was $111.1 million.', rNI, F.targetsFor(fr, rNI));
assert(gaap && gaap.match && gaap.match.quoted === '$111.0 million', 'GAAP figure in the same sentence still verifies');
const thr = F.scoreSentence('“We delivered a record quarter, exceeding $1 billion in revenue for the first time,” said the Chief Executive Officer.', rRev, F.targetsFor(fr, rRev));
assert(thr && !thr.match, 'a round threshold is context, not verification');

// 7. a figure equal to the size of the move only verifies when it is described as a move
const fe = { chart: { equity: [['2025Q2', 61328e6, 0], ['2025Q3', 60021e6, 0], ['2025Q4', 59142e6, 0], ['2026Q1', 34235e6, 0], ['2026Q2', 38378e6, 0]] } };
const rEq = { rule: 'equityErosion', metric: 'equity', basis: 'YoY' };
const coinc = F.scoreSentence('As of July 31, 2026, the Company was authorized to purchase a remaining $22.9 billion of its common stock under the Share Repurchase Program.', rEq, F.targetsFor(fe, rEq));
assert(!coinc || !coinc.match, 'coincidental figure equal to the move is not verification');
const real = F.scoreSentence('Stockholders’ equity decreased by $22.9 billion during the period, primarily due to share repurchases.', rEq, F.targetsFor(fe, rEq));
assert(real && real.match && real.match.which === 'change', 'a described move verifies');

// 8. foreign-issuer results table (layout copied from an SK hynix 6-K): quarterly line only, YTD and markers dropped
const sk = `<table><TR> <TD NOWRAP> <P><B>Classification</B></P> <P><B>(unit : in millions of Won or %)</B></P></TD> <TD>&nbsp;&nbsp;</TD> <TD><B>Current&nbsp;Period<BR>(Third<BR>quarter<SUP>(1)</SUP><BR>of 2026)</B></TD> <TD>&nbsp;</TD> <TD><B>Previous&nbsp;Period<BR>(Second<BR>quarter<SUP>(2)</SUP><BR>of 2026)</B></TD> <TD><B>Changes<BR>(%)</B></TD> <TD><B>Year-to-Year<BR>Comparison<BR>(Third<BR>quarter<SUP>(1)</SUP><BR>of 2025)</B></TD> <TD><B>Changes<BR>(%)</B></TD></TR>
<TR> <TD> <P><B>Profit (Loss) for the Period</B></P></TD> <TD>&nbsp;&nbsp;</TD> <TD><B>Quarterly Results<BR>YTD<SUP>(3)</SUP> Results</B></TD> <TD>&nbsp;<BR></TD> <TD>39,775,593<BR>174,044,095</TD> <TD NOWRAP>&nbsp;<BR>&nbsp;</TD> <TD>93,922,593<BR>N.A.</TD> <TD NOWRAP>&nbsp;<BR>*&nbsp;</TD> <TD>&nbsp;<BR> <P></P></TD> <TD>(57.7<BR> <P>N.A.</P></TD> <TD NOWRAP>)&nbsp;<BR> <P>*&nbsp;</P></TD> <TD>12,597,538<BR>27,701,949</TD> <TD>215.7<BR>528.3</TD></TR></table>`;
const tb = F.resultsTable(sk);
assert.strictEqual(tb.unit, 'millions of Won or %');
assert.deepStrictEqual(tb.rows[0], ['Profit (Loss) for the Period', '39,775,593', '93,922,593', '(57.7)', '12,597,538', '215.7']);
assert(/Current Period \(Third quarter of 2026\)/.test(tb.header[1]), tb.header[1]);

assert.strictEqual(F.resultsTable('<table><tr><td>Revenue</td><td>18,620</td><td>17,788</td></tr></table>'), null, 'no table without identified column headers');

// 9. the line item must sit next to the figure
const fs2 = { chart: { equity: [['2025Q3', 33133e6, 0], ['2025Q4', 31127e6, 0], ['2026Q1', 31173e6, 0], ['2026Q2', 31501e6, 0], ['2026Q3', 19710e6, 0]] } };
const far = F.scoreSentence('Compared with 2 percentage points last year and higher lease impairments in 2025, Corporate Unallocated expense decreased 41% primarily due to lower professional fees.', rEq, F.targetsFor(fs2, rEq));
assert(!far || !far.match, 'figure about another line item does not verify');

console.log('All filings tests passed.');
