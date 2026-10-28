// Wraps the dashboard fragment into a full HTML document for GitHub Pages (docs/index.html).
const fs = require('fs'); const path = require('path');
const frag = fs.readFileSync(path.join(__dirname, 'dashboard', 'dashboard.html'), 'utf8');
const desc = 'Sudden shifts in US-listed companies’ SEC filings: cash collapses, earnings swings, debt jumps and write-downs, each with a chart and the reason it was flagged. Updated automatically.';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="${desc}">
<meta property="og:title" content="Delta Scanner">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232147b5'/%3E%3Cpath d='M16 7 26 25H6Z' fill='none' stroke='white' stroke-width='3' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${frag}
</body>
</html>
`;
fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
console.log('docs/index.html built');
