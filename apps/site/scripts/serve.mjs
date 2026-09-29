#!/usr/bin/env node
// A static server that answers like the Vercel project: files first, then the
// rewrite in vercel.json (everything but api/, assets/, play and BeachBingo-* to /).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] || new URL('../public/', import.meta.url).pathname;
const PORT = Number(process.argv[3] || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const EXCLUDE = /^\/(?:api\/|assets\/|play|BeachBingo-)/;

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  let file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(400).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    if (EXCLUDE.test(p)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
    file = join(ROOT, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on ${PORT}`));
