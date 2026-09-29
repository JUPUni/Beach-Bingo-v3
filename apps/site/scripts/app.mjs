#!/usr/bin/env node
// Builds the Season 3 game (apps/web) and puts it at public/app/, which beachbingo.xyz serves
// at /app/. Run it after any change to the game or the engine:
//
//   pnpm --filter @beach-bingo/site app
//
// The game is built with Vite's base /app/ (apps/web/vite.config.ts), so every URL it writes,
// its manifest's scope and its service worker's scope start with /app/: it never caches or
// controls the landing page or /play. public/app/ is replaced whole each time; commit it.
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = join(ROOT, 'apps/web/dist');
const OUT = fileURLToPath(new URL('../public/app/', import.meta.url));

const built = spawnSync('pnpm', ['--filter', '@beach-bingo/web', 'build'], { cwd: ROOT, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

// A page or worker pointing outside /app/ would load the landing page's files, or take it over.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const outside = [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('/app/'));
if (outside.length) throw new Error(`the game's page names files outside /app/: ${outside.join(', ')}`);
const register = readFileSync(join(DIST, 'registerSW.js'), 'utf8');
if (!register.includes("register('/app/sw.js', { scope: '/app/' })")) throw new Error('the service worker is not /app/sw.js with scope /app/');
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'));
if (manifest.scope !== '/app/' || manifest.start_url !== '/app/') throw new Error('the manifest does not start and stay in /app/');

rmSync(OUT, { recursive: true, force: true });
cpSync(DIST, OUT, { recursive: true });

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path);
    else {
      files += 1;
      bytes += st.size;
    }
  }
};
walk(OUT);
console.log(`public/app/: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
