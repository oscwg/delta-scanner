#!/usr/bin/env node
/*
 * Local Delta Scanner: serves the dashboard at http://localhost:8787 and rescans SEC EDGAR every 10 minutes.
 *   node serve.js            (or double-click "Start Delta Scanner.command" on a Mac)
 * The SEC requires a contact User-Agent; it is read from SEC_USER_AGENT or the file .sec-agent next to this script.
 * Each scan runs scan.js then build-pages.js in a child process, so a failed scan never takes the page down:
 * the last good data stays on screen and the error shows in scan.log and at /api/status.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
const PORT = +process.env.PORT || 8787;
const EVERY_MIN = +process.env.SCAN_EVERY_MIN || 10;
const LOG = path.join(ROOT, 'scan.log');

const agentFile = path.join(ROOT, '.sec-agent');
const UA = process.env.SEC_USER_AGENT || (fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8').trim() : '');
if (!/@/.test(UA)) {
  console.error('No SEC contact set. Run the start file again, or: SEC_USER_AGENT="Your Name you@example.com" node serve.js');
  process.exit(1);
}

const status = { running: false, lastStart: null, lastEnd: null, lastOk: null, lastError: null, runs: 0, nextAt: null, everyMinutes: EVERY_MIN };
const log = (m) => { const line = `${new Date().toISOString()} ${m}\n`; process.stdout.write(line); fs.appendFileSync(LOG, line); };

function run(script) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, env: { ...process.env, SEC_USER_AGENT: UA } });
    let tail = '';
    const keep = (d) => { const s = d.toString(); fs.appendFileSync(LOG, s); tail = (tail + s).slice(-600); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    p.on('close', (code) => resolve({ code, tail }));
  });
}

async function scan() {
  if (status.running) return;
  status.running = true; status.lastStart = new Date().toISOString(); status.runs++;
  log(`Scan ${status.runs} started`);
  const s = await run('scan.js');
  if (s.code === 0) {
    const b = await run('build-pages.js');
    status.lastOk = new Date().toISOString(); status.lastError = b.code === 0 ? null : 'page build failed';
    log(`Scan ${status.runs} finished`);
  } else {
    status.lastError = s.tail.trim().split('\n').slice(-2).join(' ');
    log(`Scan ${status.runs} failed; previous data kept. ${status.lastError}`);
  }
  status.running = false; status.lastEnd = new Date().toISOString();
}

function schedule() {
  // align to the clock (…:00, :10, :20 …) so runs are predictable
  const ms = EVERY_MIN * 60e3, next = Math.ceil((Date.now() + 1000) / ms) * ms;
  status.nextAt = new Date(next).toISOString();
  setTimeout(async () => { await scan(); schedule(); }, next - Date.now());
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(status)); }
  const file = path.normalize(path.join(DOCS, url === '/' ? 'index.html' : url));
  if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  log(`Delta Scanner running at ${link}. Rescanning SEC every ${EVERY_MIN} minutes. Close this window to stop.`);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) spawn('open', [link], { stdio: 'ignore', detached: true }).unref();
  scan().then(schedule);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is busy: Delta Scanner is probably already running. Open http://localhost:${PORT}`); process.exit(0); }
  throw e;
});
