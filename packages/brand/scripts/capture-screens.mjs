#!/usr/bin/env node
// Captures the app screens the dApp Store screenshots are made from, in the
// mockup phone's screen shape (devices/<DEVICE_NAME>/device.json; the iPhone 14
// Pro Max's is 428 x 926 CSS px at 3x, 1284 x 2778).
//
//   pnpm dev                                   # the web app, in another shell
//   pnpm --filter @beach-bingo/brand screens   # writes screens/captures/*.jpg
//   pnpm brand                                 # composes them into the kit
//
// Needs a Chromium: set CHROME_PATH, or have Google Chrome installed.
// BASE_URL defaults to the Vite dev server.

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const sharp = require('sharp');

const OUT = fileURLToPath(new URL('../screens/captures/', import.meta.url));
// The device name is read out of src/screens.mjs as text, so this script does not load sharp's
// composer, the fonts and the device art just to capture.
const DEVICE_NAME = readFileSync(new URL('../src/screens.mjs', import.meta.url), 'utf8').match(/DEVICE_NAME = '([^']+)'/)[1];
const { capture: CAP } = JSON.parse(readFileSync(new URL(`../devices/${DEVICE_NAME}/device.json`, import.meta.url), 'utf8'));
const BASE = process.env.BASE_URL || 'http://localhost:5173/';

// A player a week in: shells, a pack of coins, keys, boosters, and the first seven levels starred.
const SAVE = {
  state: {
    shells: 4250,
    coins: 1500,
    table: 'shells',
    ageGate: { confirmedAt: 1 },
    keys: 2,
    onboarded: true,
    stars: { 1: 3, 2: 3, 3: 2, 4: 3, 5: 2, 6: 3, 7: 1 },
    boosters: { seagull: 2, crab: 3, wave: 2, sun: 1 },
  },
  version: 3,
};

const play = async (page) => {
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(500);
};
const openMode = async (page, section, mode) => {
  await play(page);
  await page.getByRole('button', { name: new RegExp(section) }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: new RegExp(mode) }).first().click();
  await page.waitForTimeout(700);
};

// In store order; the names match src/screens.mjs.
const SHOTS = {
  '01-splash': async () => {},
  '02-map': async (page) => {
    await play(page);
    await page.getByRole('button', { name: /^Level \d+$/ }).click();
    await page.waitForTimeout(1200);
  },
  '03-game': async (page) => {
    await play(page);
    await page.getByRole('button', { name: /^Level \d+$/ }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /Level 8, 0 stars/ }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /Auto-daub/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '▶ Play' }).click();
    await page.waitForTimeout(17000);
  },
  '04-room': async (page) => {
    await openMode(page, 'Beach Rooms', 'Sunset Hall');
    await page.getByRole('button', { name: /\+2 cards/ }).click();
    await page.waitForTimeout(30000);
  },
  '05-pier': async (page) => {
    await openMode(page, 'Beach Rooms', 'Pier Hall');
    await page.getByRole('button', { name: /\+2 cards/ }).click();
    await page.waitForTimeout(32000);
  },
  '06-fair': async (page) => {
    await play(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Provably fair/ }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /Rotate/ }).click();
    await page.waitForTimeout(900);
  },
};

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
try {
  for (const [name, steps] of Object.entries(SHOTS)) {
    if (only.length && !only.includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: CAP.cssWidth, height: CAP.cssHeight }, deviceScaleFactor: CAP.scale, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    await page.addInitScript((save) => {
      try {
        localStorage.setItem('beach-bingo', save);
      } catch {
        /* storage blocked */
      }
    }, JSON.stringify(SAVE));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    // Room for the status bar and the home indicator or gesture bar; the app pads for them.
    await page.addStyleTag({ content: `:root{--safe-top:${CAP.statusBar}px !important;--safe-bottom:${CAP.gestureBar}px !important}` });
    await steps(page);
    await page.waitForTimeout(700);
    const png = await page.screenshot();
    await sharp(png).jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(`${OUT}${name}.jpg`);
    console.log(`captured ${name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
