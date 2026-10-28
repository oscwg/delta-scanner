# Delta Scanner

Catches sudden shifts in the reported financials of US-listed companies (cash collapsing, earnings swinging, debt jumping, goodwill written down…) and shows each one as a chart with a written reason it was picked.

Runs for free, unattended, on GitHub Actions every 3 hours. The dashboard is a public web page on GitHub Pages that anyone with the link can use, and open tabs pick up each new scan by themselves.

```
GitHub Actions (every 3h) ──► SEC EDGAR XBRL frames + Submissions APIs
        │                                (data.sec.gov, no API key)
        ▼
   engine.js  ── rules + scoring + justifications
        ▼
   docs/  ──deploy──►  https://<you>.github.io/<repo>/   ◄── friends' browsers re-check every 5 min
```

## Run it on your Mac (localhost)

Double-click **Start Delta Scanner.command**. The first time, it asks for your name and email: the SEC requires every automated tool to identify itself, and this goes only to sec.gov in the request header. Your browser then opens **http://localhost:8787**, which rescans SEC every 10 minutes (on the clock: :00, :10, :20…). Open tabs pick up each new scan by themselves, and the line under *Last scan* shows when the next one is due.

- Keep the Terminal window open while you use it; close it to stop. Nothing runs when it is closed, and the page shows the last scan's data.
- If macOS says the file can't be opened because it is from an unidentified developer, right-click it → **Open** → **Open** (once only).
- Uses Node.js 18+ if installed, otherwise the Node runtime built into the Claude desktop app.
- If a scan fails (no internet, SEC busy), the previous data stays on screen and the next scan retries. Details go to `scan.log`.
- Only your computer can open localhost. To share with friends, use the GitHub Pages setup above.

## Put it online (about 10 minutes, no coding)

You need a free GitHub account. The repository must be **public**: free accounts can only publish Pages from public repos, and public repos get unlimited Actions minutes. Nothing private is in it; your SEC contact email lives in a secret, not in the code.

1. **Create the repo.** On github.com, *New repository* → name it (e.g. `delta-scanner`) → **Public** → tick *Add a README file* → *Create repository*.
2. **Upload the files.** Unzip `delta-scanner.zip`. In the repo, *Add file → Upload files*, then drag in everything inside the `delta-scanner` folder **except** `.github` → *Commit changes*.
3. **Add the scheduler.** macOS hides folders starting with a dot, so create this one by hand: *Add file → Create new file*, type the name `.github/workflows/scan.yml` (the slashes create the folders), paste the contents of `.github/workflows/scan.yml` from the zip (in Finder press **Cmd+Shift+.** to show it), then *Commit changes*.
4. **Add the SEC contact secret.** *Settings → Secrets and variables → Actions → New repository secret*. Name `SEC_USER_AGENT`, value your name and email, e.g. `Jane Smith jane@example.com`. The SEC blocks automated requests without one.
5. **Turn on Pages.** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
6. **Run it once.** *Actions* tab → enable workflows if asked → *Delta scan* → *Run workflow*. After 2–4 minutes the run shows a green tick and a link.

Your link is `https://<your-username>.github.io/<repo-name>/`. Share that. Links to a single company work too: open it, click the company, copy the address (it ends in something like `#t-GILD`).

From then on it scans every 10 minutes and republishes the page. Anyone with the page open sees a "New scan loaded" notice when fresh results arrive; there's nothing to refresh.

## Why this design holds up

| Choice | Why it lasts |
|---|---|
| SEC EDGAR as the only data source | Official, free, keyless, public-domain. No scraped site or unofficial API to break. |
| XBRL **frames** endpoint | One request returns one line item for *every* filer in a quarter, so a full-market scan is ~200 requests instead of thousands. |
| Zero dependencies (Node built-in `fetch`) | Nothing to go out of date or fail to install. |
| Offline self-test before every scan | A broken engine change stops the run instead of publishing bad flags. |
| Sanity guard in `scan.js` | If SEC is down or blocking (fewer than 200 companies come back), the previous data is kept. |
| Static dashboard reading a JSON file | No server, database or hosting bill. Viewers' tabs re-check the file every 2 minutes. |
| Rate limit ~8 req/s with retries, back-off and a 30-second timeout per request | Inside the SEC's 10 req/s fair-access limit; a hung request cannot stall the run. Going over the limit gets the runner blocked for about 10 minutes, so concurrency stays low. |

**Keeping the schedule alive.** GitHub pauses scheduled workflows in public repos after 60 days without repository activity. Each run commits a small history file, which counts as activity; if GitHub ever emails that the workflow was disabled, re-enable it from the Actions tab (one click). GitHub also emails you if a scheduled run fails, and the last good version of the page stays online meanwhile.

**Repo size stays small.** Only `docs/data/history.json` (first-seen dates) and `last-run.json` are committed each run; the full results go straight to the website.

## What it checks

Every company is compared with **itself**: latest quarter vs the same quarter last year (YoY) and vs the prior quarter (QoQ), scored on the size of the move, its materiality (share of total assets or quarterly revenue) and a robust z-score against the company's last eight YoY changes.

| Flag | Fires when |
|---|---|
| Liquidity shock | Cash −40% YoY or −35% QoQ, and the drop is ≥5% of assets |
| Cash surge | Cash +100% YoY or +75% QoQ, adding ≥5% of assets |
| Earnings swing | Net income flips sign with a swing ≥8% of quarterly revenue, or doubles / falls ≥60% |
| Revenue shock | Revenue −20% or +50% YoY |
| Margin shift | Operating margin moves ≥15pp YoY, with operating income moving ≥1% of assets |
| Leverage jump | Long-term debt +50% YoY or +35% QoQ, adding ≥5% of assets |
| Equity erosion | Equity turns negative, or −30% YoY by ≥5% of assets |
| Goodwill write-down | Goodwill −20% in one quarter, ≥2% of assets |
| Receivables stretch / Inventory build | Growth beats revenue growth by 30pp / 40pp |
| Balance-sheet transformation | Total assets +50% or −30% YoY (≥$1bn): flags likely M&A |
| 8-K overlay | Restatement (4.02), bankruptcy (1.03), acceleration (2.04), delisting notice (3.01), auditor change (4.01), impairment (2.06), restructuring (2.05) filed in the last 150 days |

Two filters keep the list to genuine shifts. **Own-history gate:** a YoY move must sit at least 3 robust standard deviations (median/MAD) outside the company's last eight YoY changes (2 for a profit/loss flip). **Base-effect screen:** if the latest quarter is in line with the three before it, the YoY swing came from an unusual year-ago quarter (say, last year's impairment) and is dropped. ETFs, commodity trusts and funds are excluded from the universe.

Each flag carries a confidence label: **High** (directly reported quarterly values), **Medium** (uses a fiscal Q4 derived as annual minus nine months, too little history for the z-test, or a foreign filer), **Low** (possible XBRL scaling error, or an annual figure tagged in a proxy statement rather than the 10-K).

## Freshness and quotes

**Same-day filings.** Each run reads EDGAR's live latest-filings feed (10-Q, 10-K, 8-K, 6-K). XBRL from a 10-Q reaches the frames API within minutes of filing, so a report filed at 7am is scored on the next run (every 10 minutes) and marked *FILED Xh AGO*. Filings in the last 48 hours are always kept, whatever their score.

**Just reported.** Earnings releases (8-K Item 2.02) arrive weeks before the 10-Q and carry no XBRL, so they are not scored. They appear in their own band with headline lines quoted from the release, or from the call transcript when the company filed one.

**Foreign listings (6-K).** Large foreign companies listed in New York (SK hynix, TSMC, ASML…) report under IFRS in their own currency and file results as a 6-K, so the US-GAAP frames never score them. For tickers in `foreignWatchlist` (config.json), a results 6-K filed in the last 48 hours is shown in *Just reported* with its results table exactly as filed (current quarter, prior quarter, year-ago quarter and the company's own % changes). Year-to-date lines and footnote markers are dropped.

**What the company said.** For every fresh flag and the 80 highest-scoring ones, the scanner reads the 10-Q/10-K behind the flag and the earnings release (and any transcript or prepared remarks) filed as an 8-K exhibit for the same quarter. Quotes are kept only if they pass these checks:

| Check | Rule |
|---|---|
| Source | Verbatim sentence from an SEC document; tables, hidden iXBRL text and forward-looking boilerplate removed |
| Topic | Must be about the flagged line item (net income, cash, debt…) |
| **Figure verified** | The number equals the flagged value to the precision written, capped at 5% (a round "exceeding $1 billion" cannot verify $1.17bn) |
| Not adjusted | A figure labelled adjusted / non-GAAP / core / EBITDA in its own clause never verifies a GAAP flag |
| Moves described as moves | A figure matched to the size of the change must be worded as one (increase, fell, impairment…), so coincidences such as "$22.9bn remaining buyback authorisation" vs a $22.9bn equity fall are rejected |
| Context only | Otherwise the sentence must state a figure for the period that is at least a tenth of the move, or be a named executive's statement |

**Transcripts.** Only transcripts a company files with the SEC are used (some file the call script or CFO commentary as Exhibit 99). Third-party transcript sites are excluded because their text cannot be checked against an official record, so most companies' calls are not covered.

## Tuning

Edit `config.json`: size thresholds, exchanges, the $ floor for any move, the 8-K window, how many flags to keep, and a `watchlist` of tickers to scan regardless of size. Thresholds per rule live in `engine.js` under `evaluate()`.

## Known gaps

- **Lag:** XBRL arrives with the 10-Q/10-K, typically 1–5 weeks after the earnings release. The *Just reported* band covers the gap with quotes, not scores.
- **Feed depth:** EDGAR's latest-filings feed reaches back about 30 hours, so a run that is down for more than a day misses the *fresh* marker (not the data: frames still pick the filing up).
- **Transcripts:** most earnings calls are not filed with the SEC and are not covered.
- **Coverage:** 20-F/40-F (foreign, IFRS) filers mostly drop out; banks and insurers use different revenue tags.
- **Cash flow:** operating cash flow is year-to-date in 10-Qs and absent from quarterly frames, so quality checks use receivables and inventory.
- **Mechanical moves:** acquisitions, spin-offs and splits produce real-looking deltas; the transformation flag and 8-K Item 2.01 help spot them.
- **No market data:** market cap and price reaction are not included (no free official source).
- **Index membership:** the universe is "listed and large enough" (≈ Russell 1000 plus upper Russell 2000), not an exact S&P 500/Russell list.

## Run locally

```bash
npm test                                          # offline engine test
SEC_USER_AGENT="Your Name you@example.com" npm run scan
npm run serve                                     # then open http://localhost:8000
```

`docs/data/flags.json` ships with a snapshot of a live run (27 Oct 2026); the first scheduled run replaces it. `npm run demo` swaps in a fictional dataset that exercises every rule.

First live run, for calibration: 2,473 companies scanned, 589 flagged (24%), 546 one-off base effects screened out, ~60 seconds.
