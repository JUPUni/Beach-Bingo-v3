#!/usr/bin/env node
// QA walkthrough of the play-money game in headless Chromium at a phone (390×844, touch) and a
// laptop window (1280×800): the splash, home, the service worker, every popup, the adventure map
// with levels 1, 14 and 21 (win, lose, boosters, replay), the seven Casino Cove games (a bet, a
// round, the coin balance and the Provably-fair log), the five Beach Rooms with their bots to the
// results popup, the responsible-play limits, the faucet cooldown and what survives a reload.
// Long ball timers run on Playwright's fake clock, so a 75-ball hall takes seconds.
//
//   pnpm --filter @beach-bingo/web build && node scripts/qa/play.mjs
//
//   QA_SUITES=shell,popups,adventure,casino,rooms,limits   which parts to run (default: all)
//   QA_VIEWPORTS=phone,laptop                              which viewports (default: both)
//   Screenshots and results.json land in scripts/qa/out/.
import { writeFileSync } from 'node:fs';
import { OUT, VIEWPORTS, bodyText, coins, fitProblems, launch, player, reporter, requireBuild, runUntil, serveDist, shot, stored, text, toHome } from './lib.mjs';

requireBuild();
const { server, url } = await serveDist();
const browser = await launch();
const R = reporter();
const SUITES = (process.env.QA_SUITES || 'shell,popups,adventure,casino,rooms,limits').split(',');
const VPS = (process.env.QA_VIEWPORTS || 'phone,laptop').split(',').map((k) => [k, VIEWPORTS[k]]);
const localDay = new Date().toLocaleDateString('en-CA');
const LEVEL_REWARD = (id) => 20 + (id - 1) * 5;
const LEVEL_CALL_MS = (id) => Math.round(2600 - ((id - 1) * 1000) / 39);
const LEVEL_MAX_BALLS = { 1: 57, 14: 39, 21: 59 };

const fit = async (page, screen, vp) => {
  // Let the pop-in animations land (the mode list staggers them), and take the transient win
  // banner off the way as a player would, by tapping it.
  await page.waitForTimeout(900);
  if (await page.locator('.win-banner').count()) {
    await page.locator('.win-banner').click({ force: true });
    await page.waitForTimeout(150);
  }
  const problems = await fitProblems(page);
  R.ok(`${vp}: fit ${screen}`, problems.length === 0, problems.join('; '));
  await shot(page, `${vp}-${screen.replace(/[^a-z0-9-]+/gi, '_')}`);
};
const tap = async (p, locator) => (p.viewport.mobile ? locator.tap({ force: true }) : locator.click({ force: true }));
const openNav = async (page, label) => {
  await page.locator(`[aria-label="${label}"]`).first().click({ force: true });
  await page.locator('.popup').first().waitFor();
  await page.waitForTimeout(400); // the pop-in animation: a forced click during it lands beside its target
};
/** Settings → one of its links (Provably fair, Responsible play, Solana wallet, Credits). */
const openSetting = async (page, name) => {
  await openNav(page, 'Settings');
  await page.getByRole('button', { name }).click();
  await page.locator('.popup').last().waitFor();
  await page.waitForTimeout(400);
};
const closePopup = async (page) => {
  const layer = page.locator('.popup-layer').last();
  // A plain click: Playwright waits for the pop-in animation to settle, so the ⊗ is where it looks.
  await page.locator('.ribbon__close').last().click();
  const gone = await layer.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  if (!gone) {
    await page.keyboard.press('Escape');
    await layer.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  }
};
const goList = async (page, which) => {
  await page.locator('.mode-sign').nth(which === 'casino' ? 0 : 1).click({ force: true });
  await page.locator('.mode-card').first().waitFor();
};
const openMode = async (page, name) => {
  await page.locator('.mode-card', { hasText: name }).first().click({ force: true });
  await page.locator('.gamehead__title').waitFor();
  await page.waitForTimeout(300);
};
const back = async (page) => {
  await page.locator('.gamehead__back').click({ force: true });
  await page.locator('.mode-card').first().waitFor();
};
const lastLog = async (page) => {
  await openSetting(page, /Provably fair/);
  await page.locator('.popup--wide').waitFor();
  const items = await page.locator('.round-log li').allTextContents();
  const nonce = Number(((await bodyText(page)).match(/Next round nonce: (\d+)/) || [])[1]);
  await closePopup(page);
  const first = (items[0] ?? '').replace(/\s+/g, ' ');
  const payout = Number(((first.match(/→ (-?\d[\d,]*)/) || [])[1] || 'NaN').replace(/,/g, ''));
  return { first, items, payout, nonce };
};
const errorsOk = (p, vp, suite) => {
  const errs = p.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e));
  R.ok(`${vp}: no page or console errors during ${suite}`, errs.length === 0, [...new Set(errs)].join(' | '));
  const bad = p.bad.filter((u) => !/ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(u) || !/sw\.js|workbox/.test(u));
  R.ok(`${vp}: no failed requests during ${suite}`, bad.length === 0, [...new Set(bad)].join(' | '));
};

/* ---------------- shell: splash, home, service worker ---------------- */
async function shell(vp, viewport) {
  const p = await player(browser, { viewport, serviceWorkers: 'allow' });
  const { page } = p;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('.splash__play').waitFor({ timeout: 20_000 });
  R.ok(`${vp}: splash shows Play and the legal line`, /Provably fair · Free to play/.test(await bodyText(page)));
  await fit(page, 'splash', vp);
  const scope = await page.evaluate(async () => {
    const r = await Promise.race([navigator.serviceWorker.ready, new Promise((ok) => setTimeout(() => ok(null), 60_000))]);
    return r ? r.scope : 'not active after 60 s';
  });
  R.ok(`${vp}: service worker registers with scope /app/`, scope === url, scope);
  const updated = await page.evaluate(async () => {
    try {
      const r = await navigator.serviceWorker.getRegistration();
      await r?.update();
      return 'ok';
    } catch (e) {
      return String(e);
    }
  });
  R.ok(`${vp}: service worker update() does not throw`, updated === 'ok', updated);
  await page.locator('.splash__play').click({ force: true });
  await page.locator('.home__level').waitFor();
  R.ok(`${vp}: home starts at Level 1 with 1,000 coins and 0/3 keys`, (await text(page, '.home__level')) === 'Level 1' && (await coins(page)) === 1000 && /0\/3/.test(await text(page, '.topbar__keys')), `${await text(page, '.home__level')} · ${await coins(page)}`);
  await fit(page, 'home', vp);
  // Offline: the game still opens from the worker's cache.
  await page.reload({ waitUntil: 'networkidle' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  await p.ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const offlineOk = await page.locator('.splash__play').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await p.ctx.setOffline(false);
  R.ok(`${vp}: the game opens offline once visited`, controlled && offlineOk, `controlled=${controlled} splash=${offlineOk}`);
  errorsOk(p, vp, 'shell');
  await p.close();
}

/* ---------------- popups ---------------- */
async function popups(vp, viewport) {
  const p = await player(browser, { viewport });
  const { page } = p;
  await toHome(page, url);

  // Settings + reduce motion
  await openNav(page, 'Settings');
  await fit(page, 'popup-settings', vp);
  const before = await page.locator('.mode-sign').first().evaluate((el) => getComputedStyle(el).animationDuration);
  await page.locator('[aria-label="Reduce motion"]').click({ force: true });
  const after = await page.locator('.mode-sign').first().evaluate((el) => getComputedStyle(el).animationDuration);
  const cls = await page.locator('.app').getAttribute('class');
  R.ok(`${vp}: reduce motion shortens animations`, /reduce-motion/.test(cls ?? '') && before !== after && parseFloat(after) < 0.01, `${before} -> ${after} (${cls})`);
  await page.locator('[aria-label="Reduce motion"]').click({ force: true });
  R.ok(`${vp}: reduce motion setting persists`, (await stored(page)).settings?.reduceMotion === false);
  // Sound/music toggles reflect in the store
  await page.locator('[aria-label="Music"]').click({ force: true });
  R.ok(`${vp}: music toggle is stored`, (await stored(page)).settings?.music === false);
  await page.locator('[aria-label="Music"]').click({ force: true });

  // Wallet (no wallet installed)
  await page.getByRole('button', { name: /Solana wallet/ }).click();
  await page.locator('.popup').first().waitFor();
  await page.waitForTimeout(800);
  const walletText = await bodyText(page);
  R.ok(`${vp}: wallet popup opens without a wallet installed`, /wallet/i.test(walletText), walletText.slice(0, 200));
  R.note(`wallet popup: ${walletText.replace(/.*Solana Wallet/i, 'Solana Wallet').slice(0, 220)}`);
  await fit(page, 'popup-wallet', vp);
  await closePopup(page);

  // Fairness
  await openSetting(page, /Provably fair/);
  await page.locator('.popup--wide').waitFor();
  const fairText = await bodyText(page);
  const commitment = (fairText.match(/commitment ([0-9a-f]{64})/) || [])[1];
  R.ok(`${vp}: fairness popup shows a 64-hex commitment and nonce 0`, !!commitment && /Next round nonce: 0/.test(fairText), fairText.slice(0, 160));
  await fit(page, 'popup-fairness', vp);
  await page.getByRole('button', { name: /Rotate/ }).click();
  await page.waitForTimeout(400);
  const rotated = await bodyText(page);
  const revealed = (rotated.match(/server seed: ([0-9a-f]{64})/) || [])[1];
  const st = await stored(page);
  R.ok(`${vp}: rotate & reveal shows the old seed and a new commitment`, !!revealed && st.fairness.commitment !== commitment && /matches its commitment: yes/.test(rotated), rotated.slice(0, 200));
  R.ok(`${vp}: the revealed seed's SHA-256 is the commitment shown before rotation`, await page.evaluate(async ([seed, commit]) => {
    const bytes = Uint8Array.from(seed.match(/../g).map((h) => parseInt(h, 16)));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('') === commit;
  }, [revealed ?? '00', commitment ?? '']));
  R.ok(`${vp}: the popup keeps the retired commitment it verifies against`, /matches its commitment/.test(rotated) && rotated.includes(commitment.slice(0, 12)), 'the old commitment is not shown next to the check');
  await fit(page, 'popup-fairness-rotated', vp);
  await closePopup(page);

  // Profile
  await page.locator('.topbar__avatar').click({ force: true });
  await page.locator('.popup').first().waitFor();
  await fit(page, 'popup-profile', vp);
  await page.locator('[aria-label="Player name"]').fill('QA Bot');
  await page.locator('.avatar-grid__item').nth(3).click({ force: true });
  await page.getByRole('button', { name: 'Accept' }).click({ force: true });
  await page.waitForTimeout(300);
  R.ok(`${vp}: profile saves name and avatar`, (await stored(page)).profile?.name === 'QA Bot' && (await text(page, '.topbar__avatar')) === '🦈', JSON.stringify((await stored(page)).profile));

  // Tasks
  await openNav(page, 'Daily tasks');
  const tasksText = await bodyText(page);
  R.ok(`${vp}: tasks popup lists world progress and four daily tasks`, /0\/40/.test(tasksText) && /Daub 60 numbers/.test(tasksText) && (await page.locator('.task__claim').count()) === 4, tasksText.slice(0, 200));
  R.ok(`${vp}: unfinished tasks cannot be claimed`, (await page.locator('.task__claim:not([disabled])').count()) === 0);
  await fit(page, 'popup-tasks', vp);
  await closePopup(page);

  // Chest
  await page.locator('.topbar__keys').click({ force: true });
  await page.locator('.popup').first().waitFor();
  R.ok(`${vp}: chest needs three keys`, /0\/3 keys/.test(await bodyText(page)) && (await page.locator('.popup__footer button').isDisabled()));
  await fit(page, 'popup-chest', vp);
  await closePopup(page);

  // Faucet
  await page.locator('.topbar__coins').click({ force: true });
  await page.locator('.popup').first().waitFor();
  await fit(page, 'popup-coins', vp);
  const c0 = await coins(page);
  await page.getByRole('button', { name: /Collect 500/ }).click({ force: true });
  await page.waitForTimeout(400);
  const c1 = await coins(page);
  const countdown = await page.locator('.popup__footer button').innerText();
  R.ok(`${vp}: faucet pays 500 once and then counts down`, c1 === c0 + 500 && /^(4h 00m 0\ds|3h 59m \d\ds)$/.test(countdown.trim()) && (await page.locator('.popup__footer button').isDisabled()), `${c0} -> ${c1}, button "${countdown}"`);
  await page.locator('.popup__footer button').click({ force: true }).catch(() => {});
  R.ok(`${vp}: a second collect does nothing`, (await coins(page)) === c1);
  await closePopup(page);

  // Limits and credits
  await openSetting(page, /Responsible play/);
  R.ok(`${vp}: limits popup shows today's net result`, /Today's net result: \+0 coins/.test(await bodyText(page)), (await bodyText(page)).slice(0, 120));
  await page.locator('.chip-opt', { hasText: /^30 min$/ }).click();
  R.ok(`${vp}: reminder choice is stored`, (await stored(page)).limits?.reminderMinutes === 30);
  await fit(page, 'popup-limits', vp);
  await closePopup(page);
  await openSetting(page, /Credits/);
  R.ok(`${vp}: credits mention play money and the privacy notice`, /no cash value/.test(await bodyText(page)) && (await page.locator('a[href*="privacy"]').count()) === 1);
  await fit(page, 'popup-credits', vp);
  await closePopup(page);
  // Escape closes a popup, the backdrop too
  await openNav(page, 'Settings');
  await page.keyboard.press('Escape');
  R.ok(`${vp}: Escape closes the popup`, (await page.locator('.popup').count()) === 0);

  // Persistence across a reload
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.splash__play').click({ force: true });
  await page.locator('.home__level').waitFor();
  const s = await stored(page);
  await page.locator('.topbar__coins').click({ force: true });
  await page.locator('.popup').first().waitFor();
  const cd2 = await page.locator('.popup__footer button').innerText();
  R.ok(`${vp}: profile, coins, faucet time and reminder survive a reload`, s.profile.name === 'QA Bot' && s.coins === c1 && /^(4h 00m|3h 5\dm)/.test(cd2.trim()) && s.limits.reminderMinutes === 30 && (await text(page, '.topbar__avatar')) === '🦈', `${JSON.stringify(s.profile)} ${s.coins} "${cd2}"`);
  await closePopup(page);
  errorsOk(p, vp, 'popups');
  await p.close();
}

/* ---------------- adventure ---------------- */
async function startLevel(page, id, { seagull = false, sun = false } = {}) {
  await page.locator(`[aria-label^="Level ${id},"]`).click({ force: true });
  await page.getByRole('button', { name: /Play/ }).last().waitFor();
  if (seagull) await page.locator('.boost').nth(0).click({ force: true });
  if (sun) await page.locator('.boost').nth(1).click({ force: true });
  await page.getByRole('button', { name: /Play/ }).last().click({ force: true });
  await page.locator('.bingo-btn').waitFor();
}
const ballsLeft = async (page) => Number((await page.locator('.adv-hud__chip', { hasText: 'Balls' }).locator('b').innerText()).trim());
const currentBall = async (page) => Number(((await page.locator('.adv-caller__current').innerText().catch(() => '')).match(/\d+/) || [])[0]);

/** Daub the called numbers as a person would (touch on the phone), then advance one ball. */
async function daubCalled(p, called) {
  const { page } = p;
  const cells = await page.$$eval('.cell', (els) => els.map((el) => ({ n: Number(el.querySelector('.cell__num')?.textContent), marked: el.classList.contains('cell--marked') })));
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].n && called.has(cells[i].n) && !cells[i].marked) await tap(p, page.locator('.cell').nth(i));
  }
}

async function playLevel(p, id, { manual = false, giveUp = false, pinch = false } = {}) {
  const { page } = p;
  const callMs = LEVEL_CALL_MS(id);
  await page.clock.runFor(2300); // 3-2-1
  await page.waitForTimeout(50);
  const called = new Set();
  let pinched = false;
  for (let i = 0; i < 90; i++) {
    const n = await currentBall(page);
    if (n) called.add(n);
    if (!giveUp) {
      if (manual) await daubCalled(p, called);
      if (pinch && !pinched && i === 3) {
        await page.locator('[aria-label="Crab Pinch"]').click({ force: true });
        await page.locator('.cell--target').first().waitFor({ timeout: 3000 });
        await tap(p, page.locator('.cell--target').first());
        pinched = true;
      }
      if (await page.locator('.bingo-btn.is-ready').count()) {
        await tap(p, page.locator('.bingo-btn'));
        await page.locator('.popup', { hasText: 'You Win' }).waitFor({ timeout: 5000 });
        return 'won';
      }
    }
    if (await page.locator('.popup', { hasText: 'Out of Balls' }).count()) return 'lost';
    await page.clock.runFor(callMs);
    await page.waitForTimeout(30);
  }
  await page.clock.runFor(4200);
  await page.waitForTimeout(50);
  return (await page.locator('.popup', { hasText: 'Out of Balls' }).count()) ? 'lost' : 'timeout';
}

/** Play the level already started until it is won; a lost one (a perfect player still loses a few percent) is restarted from the map. */
async function winLevel(p, id, play = {}, boost = {}, attempts = 3) {
  for (let a = 1; ; a++) {
    const before = await coins(p.page);
    const outcome = await playLevel(p, id, play);
    if (outcome === 'won' || a >= attempts) return { outcome, before };
    R.note(`level ${id} lost on attempt ${a} (${await ballsLeft(p.page)} balls left); playing it again`);
    await p.page.locator('.popup__footer [aria-label="Level map"]').click({ force: true });
    await p.page.locator('.level-tile').first().waitFor();
    // The map opens on the current level's page; levels 1–20 are on the first page, 21–40 on the second.
    if (!(await p.page.locator(`[aria-label^="Level ${id},"]`).count())) await p.page.locator(`[aria-label="${id <= 20 ? 'Previous' : 'Next'} page"]`).click({ force: true });
    await startLevel(p.page, id, boost);
  }
}

async function adventure(vp, viewport) {
  // Fresh player: level 1 win with the seagull, replay twice, then the lose path and Big Wave.
  const p = await player(browser, { viewport, clock: true });
  const { page } = p;
  await toHome(page, url);
  await page.locator('.home__level').click({ force: true });
  await page.locator('.level-tile.is-current').waitFor();
  R.ok(`${vp}: map opens on Palm Cove with level 1 current and 2–20 locked`, /Palm Cove/.test(await text(page, '.map__title')) && (await page.locator('.level-tile.is-locked').count()) === 19);
  await fit(page, 'map', vp);
  await page.locator('[aria-label^="Level 5,"]').click({ force: true });
  R.ok(`${vp}: a locked level explains itself`, /Beat the previous level/.test(await bodyText(page)));
  await page.locator('[aria-label^="Level 1,"]').click({ force: true });
  await page.getByRole('button', { name: /Play/ }).last().waitFor();
  await fit(page, 'level-popup', vp);
  await page.locator('.boost').nth(0).click({ force: true });
  R.ok(`${vp}: the owned seagull booster arms`, (await page.locator('.boost').nth(0).getAttribute('aria-pressed')) === 'true');
  await page.getByRole('button', { name: /Play/ }).last().click({ force: true });
  await page.locator('.bingo-btn').waitFor();
  R.ok(`${vp}: level 1 starts with 57 balls and the seagull consumed`, (await ballsLeft(page)) === 57 && (await stored(page)).boosters.seagull === 0);
  await page.clock.runFor(2300);
  await page.clock.runFor(LEVEL_CALL_MS(1) * 3);
  await page.waitForTimeout(100);
  await fit(page, 'level-1-playing', vp);
  const win1 = await winLevel(p, 1, {}, { seagull: true });
  const stars = await page.locator('.popup .star--on').count();
  const st = await stored(page);
  R.ok(`${vp}: level 1 with auto-daub is won and paid reward × stars`, win1.outcome === 'won' && stars >= 1 && st.coins === win1.before + LEVEL_REWARD(1) * stars && st.stars[1] === stars, `${win1.outcome}, ${stars}★, coins ${win1.before} -> ${st.coins}`);
  R.ok(`${vp}: a win counts for the BINGO task and a 3★ win gives a key`, st.tasks.progress.bingo >= 1 && st.keys === (stars === 3 ? 1 : 0), JSON.stringify({ progress: st.tasks.progress, keys: st.keys }));
  await fit(page, 'level-won', vp);
  // Replay twice in a row: each must start a fresh run.
  await page.locator('[aria-label="Replay"]').click({ force: true });
  await page.waitForTimeout(200);
  const replay1 = (await page.locator('.popup').count()) === 0 && (await ballsLeft(page)) === 57;
  R.ok(`${vp}: Replay starts a fresh level`, replay1, `popup=${await page.locator('.popup').count()} balls=${await ballsLeft(page)}`);
  const win2 = await winLevel(p, 1, { manual: true });
  const daubed = (await stored(page)).tasks.progress.daub;
  R.ok(`${vp}: level 1 with manual daubs is won and daubs count for the task`, win2.outcome === 'won' && daubed > 0, `${win2.outcome}, daubs ${daubed}`);
  await page.locator('[aria-label="Replay"]').click({ force: true });
  await page.waitForTimeout(200);
  const replay2 = (await page.locator('.popup').count()) === 0 && (await ballsLeft(page)) === 57;
  R.ok(`${vp}: Replay a second time in a row starts a fresh level`, replay2, `popup=${await page.locator('.popup').count()} balls=${await ballsLeft(page)}`);
  if (!replay2) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.splash__play').click({ force: true });
    await page.locator('.home__level').click({ force: true });
    await page.locator('.level-tile').first().waitFor();
    await startLevel(page, 1);
  }
  // Lose path: never daub, run out of balls, ride the owned Big Wave, run out again, buy one.
  const lost = await playLevel(p, 1, { giveUp: true });
  R.ok(`${vp}: a level without daubs ends in Out of Balls after the grace period`, lost === 'lost', lost);
  await fit(page, 'level-lost', vp);
  const wavesBefore = (await stored(page)).boosters.wave;
  const waveBtn = page.locator('.popup__footer .btn-green');
  await waveBtn.click({ force: true });
  await page.waitForTimeout(100);
  R.ok(`${vp}: the owned Big Wave adds 5 balls and resumes play`, (await page.locator('.popup').count()) === 0 && (await ballsLeft(page)) === 5 && (await stored(page)).boosters.wave === wavesBefore - 1, `balls=${await ballsLeft(page)}`);
  const lost2 = await playLevel(p, 1, { giveUp: true });
  const cw = await coins(page);
  const buyLabel = await waveBtn.innerText();
  await waveBtn.click({ force: true });
  await page.waitForTimeout(100);
  R.ok(`${vp}: a bought Big Wave costs 100 coins`, lost2 === 'lost' && /100/.test(buyLabel) && (await coins(page)) === cw - 100 && (await ballsLeft(page)) === 5, `${lost2} "${buyLabel}" ${cw} -> ${await coins(page)}`);
  await page.locator('.adv-hud__back').click({ force: true });
  await page.locator('.level-tile').first().waitFor();
  R.ok(`${vp}: level 2 is unlocked after winning level 1`, (await page.locator('[aria-label^="Level 2,"]:not(.is-locked)').count()) === 1 && (await page.locator('.level-tile.is-current [class*=num]').innerText()) === '2');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.splash__play').click({ force: true });
  await page.locator('.home__level').waitFor();
  R.ok(`${vp}: stars survive a reload and home moves to Level 2`, (await text(page, '.home__level')) === 'Level 2');
  errorsOk(p, vp, 'adventure (level 1)');
  await p.close();

  // Seeded player: levels 14 (four cards) and 21 (Shipwreck Bay) with boosters.
  const seed = { onboarded: true, coins: 5000, boosters: { seagull: 3, crab: 2, wave: 1, sun: 2 }, stars: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, 1])) };
  const q = await player(browser, { viewport, clock: true, seed });
  const page2 = q.page;
  await toHome(page2, url);
  R.ok(`${vp}: home shows Coral Reef complete and Level 21 next`, (await text(page2, '.home__level')) === 'Level 21' && /Shipwreck Bay/.test(await bodyText(page2)));
  await page2.locator('.home__level').click({ force: true });
  await page2.locator('.level-tile').first().waitFor();
  R.ok(`${vp}: the map opens on the page with level 21 current`, /Shipwreck Bay/.test(await text(page2, '.map__title')) && (await page2.locator('.level-tile.is-current').count()) === 1);
  await fit(page2, 'map-page-2', vp);
  await page2.locator('[aria-label="Previous page"]').click({ force: true });
  await page2.locator('[aria-label^="Level 14,"]').waitFor();
  await startLevel(page2, 14, { seagull: true });
  R.ok(`${vp}: level 14 deals four cards and 39 balls`, (await page2.locator('.grid').count()) === 4 && (await ballsLeft(page2)) === 39);
  await page2.clock.runFor(2300 + LEVEL_CALL_MS(14) * 4);
  await page2.waitForTimeout(100);
  await fit(page2, 'level-14-four-cards', vp);
  const w14 = await winLevel(q, 14, {}, { seagull: true });
  const s14 = await page2.locator('.popup .star--on').count();
  R.ok(`${vp}: level 14 is won with auto-daub and paid ${LEVEL_REWARD(14)} × stars`, w14.outcome === 'won' && (await coins(page2)) === w14.before + LEVEL_REWARD(14) * s14, `${w14.outcome} ${s14}★ ${w14.before} -> ${await coins(page2)}`);
  await fit(page2, 'level-14-won', vp);
  await page2.locator('[aria-label="Next level"]').click({ force: true });
  await page2.locator('.bingo-btn').waitFor();
  R.ok(`${vp}: Next level opens level 15`, /Lv 15/.test(await text(page2, '.adv-caller__level')));
  await page2.locator('.adv-hud__back').click({ force: true });
  await page2.locator('.level-tile').first().waitFor();
  await page2.locator('[aria-label="Next page"]').click({ force: true });
  await page2.locator('[aria-label^="Level 21,"]').waitFor();
  // Level 21: manual daubs, a Crab Pinch and the Golden Sun (double coins).
  await startLevel(page2, 21, { sun: true });
  const crabs0 = (await stored(page2)).boosters.crab;
  R.ok(`${vp}: level 21 (Four Corners, 4 cards) starts with the sun armed`, (await ballsLeft(page2)) === 59 && (await page2.locator('[aria-label="2× coins"]').getAttribute('aria-pressed')) === 'true' && (await stored(page2)).boosters.sun === 1);
  const w21 = await winLevel(q, 21, { manual: true, pinch: true }, { sun: true });
  const s21 = await page2.locator('.popup .star--on').count();
  const st21 = await stored(page2);
  R.ok(`${vp}: level 21 with manual daubs + Crab Pinch is won and the sun doubles the reward`, w21.outcome === 'won' && st21.coins === w21.before + LEVEL_REWARD(21) * s21 * 2 && st21.boosters.crab < crabs0, `${w21.outcome} ${s21}★ ${w21.before} -> ${st21.coins} crabs ${crabs0} -> ${st21.boosters.crab}`);
  await fit(page2, 'level-21-won', vp);
  await page2.locator('[aria-label="Replay"]').click({ force: true});
  await page2.locator('.bingo-btn').waitFor();
  const o21b = await playLevel(q, 21, { giveUp: true });
  R.ok(`${vp}: level 21 lose path reaches Out of Balls`, o21b === 'lost', o21b);
  await page2.locator('[aria-label="Level map"]').click({ force: true });
  await page2.locator('.level-tile').first().waitFor();
  errorsOk(q, vp, 'adventure (levels 14 and 21)');
  await q.close();
}

/* ---------------- casino cove ---------------- */
async function casino(vp, viewport) {
  const p = await player(browser, { viewport, seed: { onboarded: true, coins: 3000 } });
  const { page } = p;
  await toHome(page, url);
  await goList(page, 'casino');
  const cards = await page.locator('.mode-card').allInnerTexts();
  R.ok(`${vp}: Casino Cove lists the seven house games with an RTP each`, cards.length === 7 && cards.every((c) => /RTP/.test(c)), cards.map((c) => c.split('\n')[0]).join(', '));
  R.note(`mode cards: ${cards.map((c) => c.replace(/\s+/g, ' ').match(/RTP [^👥⏱]*/)?.[0]?.trim()).join(' | ')}`);
  await fit(page, 'casino-list', vp);
  const spent = [];
  /** Leaves the game (the Provably-fair log opens from the list's nav) and checks the ledger against it. */
  const settleCheck = async (name, stake, extra = 0) => {
    const now = await coins(page);
    await back(page);
    const { first, payout, nonce } = await lastLog(page);
    const expected = spent.at(-1) - stake - extra + payout;
    R.ok(`${vp}: ${name}: coins = before − stake + payout (${spent.at(-1)} − ${stake}${extra ? ` − ${extra}` : ''} + ${payout} = ${expected})`, Number.isFinite(payout) && now === expected, `now ${now}; log "${first}"`);
    return { payout, nonce, first };
  };
  const roundIdle = async () => {
    await page.waitForTimeout(400);
    await page.locator('.casino__go:not([disabled])').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(200);
  };

  // Tide Pool
  await openMode(page, 'Tide Pool');
  R.ok(`${vp}: Tide Pool paytable shows the sea's RTP`, /RTP 97\.\d+%/.test(await bodyText(page)));
  await fit(page, 'casino-tide-pool', vp);
  spent.push(await coins(page));
  await page.locator('.casino__go').click({ force: true });
  await roundIdle();
  R.ok(`${vp}: Tide Pool reveals 35 balls and a result per card`, (await page.locator('.ball-tray .ball').count()) === 35 && (await page.locator('.tide-card__result').count()) === 2);
  await fit(page, 'casino-tide-pool-result', vp);
  const chip = await text(page, '.fair-chip');
  const tide = await settleCheck('Tide Pool', 50);
  R.ok(`${vp}: the fair chip shows the round's nonce`, chip.includes(`#${tide.nonce - 1}`), chip);

  // Crab Dig
  await openMode(page, 'Crab Dig');
  await fit(page, 'casino-crab-dig', vp);
  spent.push(await coins(page));
  await page.getByRole('button', { name: /Start digging/ }).click({ force: true });
  await page.waitForTimeout(200);
  await tap(p, page.locator('[aria-label="Square 1"]'));
  await page.waitForTimeout(200);
  let digPayout = 0;
  if (await page.locator('.dig-cell.is-crab').count()) {
    R.note('Crab Dig: pinched on the first dig');
  } else {
    const label = await page.getByRole('button', { name: /^Bank/ }).innerText();
    await page.getByRole('button', { name: /^Bank/ }).click({ force: true });
    await page.waitForTimeout(300);
    digPayout = Number(label.replace(/[^\d]/g, ''));
  }
  await fit(page, 'casino-crab-dig-result', vp);
  const dig = await settleCheck('Crab Dig', 50);
  if (digPayout) R.ok(`${vp}: Crab Dig's Bank button showed the amount actually paid`, digPayout === dig.payout, `button ${digPayout} vs paid ${dig.payout}`);

  // Beach Ball Blitz
  await openMode(page, 'Beach Ball Blitz');
  const blitzText = await bodyText(page);
  R.ok(`${vp}: Blitz shows the target, its multiplier and RTP`, /Full house by ball 22/.test(blitzText) && /Pays [\d,.]+×/.test(blitzText) && /RTP 97%/.test(blitzText));
  await page.locator('input[type=range]').fill('27');
  R.ok(`${vp}: moving the slider updates the payout`, /Full house by ball 27/.test(await bodyText(page)));
  await fit(page, 'casino-blitz', vp);
  spent.push(await coins(page));
  await page.locator('.casino__go').click({ force: true });
  await roundIdle();
  await fit(page, 'casino-blitz-result', vp);
  await settleCheck('Blitz', 25);

  // Shell Spin
  await openMode(page, 'Shell Spin');
  await fit(page, 'casino-shell-spin', vp);
  spent.push(await coins(page));
  for (let i = 0; i < 40; i++) {
    if (await page.getByRole('button', { name: /^Collect/ }).count()) {
      await page.getByRole('button', { name: /^Collect/ }).click({ force: true });
      break;
    }
    if (await page.locator('.spin-status button').count()) await page.locator('.spin-status button').click({ force: true });
    else if (await page.locator('.casino__go:not([disabled])').count()) await page.locator('.casino__go').click({ force: true });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(300);
  await fit(page, 'casino-shell-spin-result', vp);
  await settleCheck('Shell Spin', 50);

  // Riptide: choppy, 100 coins, bank after the first hit; the Bank button must show what is paid.
  await openMode(page, 'Riptide');
  await page.locator('[aria-label="Raise bet"]').click({ force: true });
  R.ok(`${vp}: Riptide stake raises to 100`, /100/.test(await text(page, '.stake-picker__value')));
  await fit(page, 'casino-riptide', vp);
  let riptideDone = false;
  for (let attempt = 0; attempt < 4 && !riptideDone; attempt++) {
    spent.push(await coins(page));
    await page.getByRole('button', { name: /Ride the tide/ }).click({ force: true });
    let label = '';
    for (let t = 0; t < 120; t++) {
      await page.waitForTimeout(250);
      if (await page.locator('.riptide-meter.is-bitten').count()) break;
      const bank = page.getByRole('button', { name: /^Bank/ });
      if ((await bank.count()) && !(await bank.isDisabled())) {
        label = await bank.innerText();
        await bank.click({ force: true });
        break;
      }
    }
    await page.waitForTimeout(400);
    await fit(page, 'casino-riptide-result', vp);
    if (label) {
      riptideDone = true;
      const r = await settleCheck('Riptide', 100);
      R.ok(`${vp}: Riptide's Bank button showed the amount actually paid`, Number(label.replace(/[^\d]/g, '')) === r.payout, `button "${label}" vs paid ${r.payout}`);
    } else {
      await settleCheck('Riptide (bitten)', 100);
      await openMode(page, 'Riptide');
      await page.locator('[aria-label="Raise bet"]').click({ force: true });
    }
  }
  if (!riptideDone) await back(page);

  // Tiki Video Bingo: one card, 10 coins, one extra ball if offered.
  await openMode(page, 'Tiki Video Bingo');
  await page.locator('.segmented button').first().click({ force: true });
  await fit(page, 'casino-video-bingo', vp);
  spent.push(await coins(page));
  await page.getByRole('button', { name: /^Play 10/ }).click({ force: true });
  await page.waitForTimeout(2500);
  let extraPrice = 0;
  const extra = page.getByRole('button', { name: /Extra ball/ });
  if (await extra.count()) {
    extraPrice = Number((await extra.innerText()).replace(/[^\d]/g, ''));
    const cBefore = await coins(page);
    await extra.click({ force: true });
    await page.waitForTimeout(600);
    R.ok(`${vp}: an extra ball costs its listed price`, (await coins(page)) === cBefore - extraPrice, `${cBefore} -> ${await coins(page)} price ${extraPrice}`);
    if (await page.getByRole('button', { name: /^Collect/ }).count()) await page.getByRole('button', { name: /^Collect/ }).click({ force: true });
  } else {
    R.note('Video Bingo: no extra ball was offered this round');
  }
  await page.waitForTimeout(400);
  await fit(page, 'casino-video-bingo-result', vp);
  await settleCheck('Video Bingo', 10, extraPrice);

  // Keno Cove
  await openMode(page, 'Keno Cove');
  await page.getByRole('button', { name: /Quick pick/ }).click({ force: true });
  const picked = (await bodyText(page)).match(/(\d+)\/10 picked/)?.[1];
  R.ok(`${vp}: quick pick chooses 5–10 shells and shows a paytable`, Number(picked) >= 5 && (await page.locator('.keno-pays span').count()) === Number(picked) + 1, `${picked} picked`);
  await fit(page, 'casino-keno', vp);
  spent.push(await coins(page));
  await page.getByRole('button', { name: /Draw 10/ }).click({ force: true });
  await roundIdle();
  R.ok(`${vp}: Keno draws ten shells`, (await page.locator('.keno-cell.is-drawn, .keno-cell.is-hit').count()) === 10);
  await fit(page, 'casino-keno-result', vp);
  const keno = await settleCheck('Keno', 25);

  // Tasks and the fairness log after seven games.
  const st = await stored(page);
  R.ok(`${vp}: seven house rounds count for the tasks and advance the nonce`, st.tasks.progress.spins >= 7 && st.tasks.progress.modes >= 7 && keno.nonce >= 7, JSON.stringify({ progress: st.tasks.progress, nonce: keno.nonce }));
  await openNav(page, 'Daily tasks');
  const ready = page.locator('.task__claim.is-ready');
  const cT = await coins(page);
  R.ok(`${vp}: "Play 3 different games" is claimable`, (await ready.count()) >= 1);
  await ready.first().click({ force: true });
  await page.waitForTimeout(300);
  R.ok(`${vp}: claiming the task pays 250 coins once`, (await coins(page)) === cT + 250 && (await page.locator('.task__claim', { hasText: '✓' }).count()) === 1, `${cT} -> ${await coins(page)}`);
  await closePopup(page);
  const { items } = await lastLog(page);
  R.ok(`${vp}: the Provably-fair log lists the rounds with nonce, mode and result`, items.length >= 7 && items.slice(0, 7).every((l) => /#\d+ \w+ — .*→ \d/.test(l.replace(/\s+/g, ' '))), items.slice(0, 3).join(' | '));
  // Persistence
  const before = await stored(page);
  await page.reload({ waitUntil: 'networkidle' });
  const after = await stored(page);
  R.ok(`${vp}: coins, nonce and task progress survive a reload`, after.coins === before.coins && after.fairness.nonce === before.fairness.nonce && after.tasks.progress.spins === before.tasks.progress.spins);
  errorsOk(p, vp, 'casino');
  await p.close();
}

/* ---------------- beach rooms ---------------- */
async function rooms(vp, viewport) {
  const p = await player(browser, { viewport, clock: true, seed: { onboarded: true, coins: 3000 } });
  const { page } = p;
  await toHome(page, url);
  await goList(page, 'rooms');
  const cards = await page.locator('.mode-card').allInnerTexts();
  R.ok(`${vp}: Beach Rooms lists five halls and the join box`, cards.length === 5 && (await page.locator('#join-code').count()) === 1, cards.map((c) => c.split('\n')[0]).join(', '));
  await page.fill('#join-code', 'ab1o2');
  R.ok(`${vp}: the join box drops look-alike characters and needs five`, (await page.inputValue('#join-code')) === 'AB2' && (await page.getByRole('button', { name: 'Join' }).isDisabled()));
  await page.fill('#join-code', '');
  await fit(page, 'rooms-list', vp);
  const results = async () => ({
    title: await text(page, '.popup .ribbon__title'),
    lines: await page.locator('.room__results li').allTextContents(),
    note: await text(page, '.popup .small-note'),
    win: Number(((await page.locator('.popup .reward-pill').innerText().catch(() => '+0')).match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, '')),
  });
  const runRoom = async (name, buyIndex, screen, drawMs, maxBalls) => {
    await openMode(page, name);
    const lobby = await bodyText(page);
    const bots = Number((lobby.match(/(\d+) labelled bot/) || [])[1]);
    R.ok(`${vp}: ${name} opens as a practice room with labelled bots`, /Practice room|Duel lobby/.test(lobby) && bots >= 1 && /🤖/.test(lobby), lobby.slice(0, 160));
    await fit(page, `${screen}-lobby`, vp);
    const c0 = await coins(page);
    const btn = page.locator('.room__buy .btn-green').nth(buyIndex);
    const label = await btn.innerText();
    const cost = Number(label.replace(/.*· /, ''));
    await btn.click({ force: true });
    await page.waitForTimeout(100);
    R.ok(`${vp}: ${name}: buying "${label.trim()}" takes ${cost} coins and starts the countdown`, (await coins(page)) === c0 - cost && /Starting in/.test(await text(page, '.room__count')), `${c0} -> ${await coins(page)}`);
    const started = await runUntil(page, 1000, 12_000, async () => (await page.locator('.room__caller .ball').count()) > 0);
    R.ok(`${vp}: ${name}: the round starts after the countdown`, started);
    await page.clock.runFor(drawMs * 3);
    await page.waitForTimeout(100);
    await fit(page, `${screen}-drawing`, vp);
    return { c0, cost };
  };
  const finishRoom = async (name, screen, drawMs, maxBalls, c0, cost, stages) => {
    const done = await runUntil(page, drawMs * 5, drawMs * (maxBalls + 6), async () => (await page.locator('.popup').count()) > 0);
    const r = done ? await results() : null;
    R.ok(`${vp}: ${name}: the round reaches the results popup with ${stages} stage(s) settled`, done && r.lines.length >= stages && /pool/.test(r.note), r ? `${r.title}: ${r.lines.join(' | ')} — ${r.note}` : 'no popup');
    R.ok(`${vp}: ${name}: coins = before − cards + prize (${c0} − ${cost} + ${r?.win ?? '?'})`, r && (await coins(page)) === c0 - cost + r.win, `now ${await coins(page)}`);
    await fit(page, `${screen}-results`, vp);
    return r;
  };

  // Sunset Hall (75-ball, jackpot) — then Play again must open a fresh lobby.
  let { c0, cost } = await runRoom('Sunset Hall', 0, 'room-sunset', 2500, 75);
  R.ok(`${vp}: Sunset Hall shows a jackpot stat and the stage being played`, (await page.locator('.room-stat--jackpot').count()) === 1 && /Any Line/.test(await text(page, '.room__stage')));
  await finishRoom('Sunset Hall', 'room-sunset', 2500, 75, c0, cost, 3);
  await page.getByRole('button', { name: 'Play again' }).click({ force: true });
  await page.waitForTimeout(300);
  R.ok(`${vp}: Sunset Hall: Play again opens a fresh practice lobby`, (await page.locator('.popup').count()) === 0 && (await page.locator('.room__lobby h2', { hasText: 'Practice room' }).count()) === 1, `popup=${await page.locator('.popup').count()} lobby=${await page.locator('.room__lobby').count()}`);
  await back(page).catch(async () => {
    await page.locator('.gamehead__back').click({ force: true });
  });

  // Pier Hall (90-ball tickets)
  ({ c0, cost } = await runRoom('Pier Hall', 2, 'room-pier', 2200, 90));
  R.ok(`${vp}: Pier Hall deals three 90-ball tickets with 12 blanks each`, (await page.locator('.grid--v90').count()) === 3 && (await page.locator('.cell--blank').count()) === 36);
  await finishRoom('Pier Hall', 'room-pier', 2200, 90, c0, cost, 3);
  await page.getByRole('button', { name: 'Rooms' }).click({ force: true });
  await page.locator('.mode-card').first().waitFor();

  // Wave Rush (30-ball)
  ({ c0, cost } = await runRoom('Wave Rush', 2, 'room-wave', 1400, 30));
  R.ok(`${vp}: Wave Rush deals 3×3 cards`, (await page.locator('.grid--v30').count()) === 3);
  await finishRoom('Wave Rush', 'room-wave', 1400, 30, c0, cost, 1);
  await page.getByRole('button', { name: 'Rooms' }).click({ force: true });
  await page.locator('.mode-card').first().waitFor();

  // Last Castle Standing
  await openMode(page, 'Last Castle');
  await fit(page, 'room-castle-lobby', vp);
  c0 = await coins(page);
  await page.getByRole('button', { name: /Join · 50/ }).click({ force: true });
  await page.waitForTimeout(100);
  R.ok(`${vp}: Last Castle takes the 50-coin buy-in and seats 32 castles`, (await coins(page)) === c0 - 50 && /Castles left 32/i.test((await bodyText(page)).replace(/\s+/g, ' ')), (await bodyText(page)).slice(0, 200));
  await runUntil(page, 1000, 6000, async () => (await page.locator('.room__caller .ball').count()) > 0);
  await fit(page, 'room-castle-playing', vp);
  const castleDone = await runUntil(page, 3200, 3200 * 12, async () => (await page.locator('.popup').count()) > 0);
  const castle = castleDone ? await results() : null;
  // 32 castles halve five times: 5 waves × 5 balls.
  R.ok(`${vp}: Last Castle finishes with a champion after 25 balls and pays places`, castleDone && /Champion!|Place #\d+/.test(castle.title) && /Champion: .* · 25 balls · 32 players/.test(castle.note), castle ? `${castle.title} — ${castle.note}` : 'no popup');
  R.ok(`${vp}: Last Castle coins = before − 50 + prize`, castle && (await coins(page)) === c0 - 50 + castle.win, `${c0} -> ${await coins(page)} prize ${castle?.win}`);
  await fit(page, 'room-castle-results', vp);
  const cAgain = await coins(page);
  await page.getByRole('button', { name: /Again · 50/ }).click({ force: true });
  await page.waitForTimeout(200);
  R.ok(`${vp}: Last Castle: Again starts a new game for 50`, (await page.locator('.popup').count()) === 0 && (await coins(page)) === cAgain - 50 && /Wave 0\//i.test((await bodyText(page)).replace(/\s+/g, ' ')), `popup=${await page.locator('.popup').count()} ${cAgain} -> ${await coins(page)}`);
  await back(page);

  // Riptide Duel: a false call, the lock-out, then a real BINGO the moment a line completes.
  ({ c0, cost } = await runRoom('Riptide Duel', 0, 'room-duel', 1800, 75));
  R.ok(`${vp}: the duel shows the BINGO button and the opponent's distance`, (await page.locator('.bingo-btn').count()) === 1 && /away from a line/.test(await bodyText(page)));
  await tap(p, page.locator('.bingo-btn'));
  const falseCall = await page.locator('.toast', { hasText: /False call/ }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  R.ok(`${vp}: a false BINGO is refused and locks the player for 3 balls`, falseCall);
  await tap(p, page.locator('.bingo-btn'));
  R.ok(`${vp}: a shout while locked is refused`, await page.locator('.toast', { hasText: /Locked out/ }).waitFor({ timeout: 3000 }).then(() => true, () => false));
  let sawOne = false;
  let claimed = false;
  const drawn = new Set();
  for (let i = 0; i < 80 && !(await page.locator('.popup').count()); i++) {
    for (const t of await page.locator('.room__caller .ball b').allTextContents()) drawn.add(Number(t));
    // daub what has been called, as a person would
    const cells = await page.$$eval('.room__cards .cell', (els) => els.map((el) => ({ n: Number(el.querySelector('.cell__num')?.textContent), marked: el.classList.contains('cell--marked') })));
    for (let k = 0; k < cells.length; k++) if (cells[k].n && drawn.has(cells[k].n) && !cells[k].marked) await tap(p, page.locator('.room__cards .cell').nth(k));
    const togo = await page.locator('.room__togo').allTextContents();
    if (togo.some((t) => /^1 to go/.test(t))) sawOne = true;
    else if (sawOne && !togo.length && !claimed && (await page.locator('.bingo-btn').count())) {
      await tap(p, page.locator('.bingo-btn'));
      claimed = await page.locator('.toast', { hasText: /BINGO claimed/ }).waitFor({ timeout: 2000 }).then(() => true, () => false);
      // The badge also goes when the opponent's confirmed bingo has just ended the round (the
      // results popup follows 0.9 s later); a shout in that window is not a false call of ours.
      if (!claimed && (await page.locator('.popup').count())) R.note('the opponent had already taken the line when the badge vanished');
      else R.ok(`${vp}: a real BINGO is accepted`, claimed);
    }
    await page.clock.runFor(1800);
    await page.waitForTimeout(40);
  }
  await page.clock.runFor(4000);
  await page.waitForTimeout(100);
  const duel = (await page.locator('.popup').count()) ? await results() : null;
  const st = await stored(page);
  R.ok(`${vp}: the duel settles: winner named, 95 of the 100-coin pot paid`, duel && duel.lines.length === 1 && /Any Line on ball \d+: .* · 95/.test(duel.lines[0]) && (duel.title === 'You Win' ? (await coins(page)) === c0 - 50 + 95 : (await coins(page)) === c0 - 50), duel ? `${duel.title}: ${duel.lines.join(' | ')} coins ${c0} -> ${await coins(page)}` : 'no popup');
  R.ok(`${vp}: manual daubs in the duel count for the daub task`, st.tasks.progress.daub > 0, String(st.tasks.progress.daub));
  await fit(page, 'room-duel-results', vp);
  await page.getByRole('button', { name: 'Rooms' }).click({ force: true });
  await page.locator('.mode-card').first().waitFor();
  const { items } = await lastLog(page);
  R.ok(`${vp}: practice rooms appear in the Provably-fair log`, items.some((l) => /sunsetHall/.test(l)) && items.some((l) => /riptideDuel/.test(l)) && items.some((l) => /lastCastle/.test(l)), items.slice(0, 4).join(' | '));
  errorsOk(p, vp, 'rooms');
  await p.close();
}

/* ---------------- responsible play limits ---------------- */
async function limits(vp, viewport) {
  const p = await player(browser, { viewport, seed: { onboarded: true, coins: 2000 } });
  const { page } = p;
  await toHome(page, url);
  await openSetting(page, /Responsible play/);
  await page.locator('.chip-opt', { hasText: '24 hours' }).click();
  R.ok(`${vp}: a cool-off is confirmed and stored`, /Wager games paused for 24 hours/.test(await bodyText(page)) && (await stored(page)).limits.coolOffUntil > Date.now(), await bodyText(page));
  await closePopup(page);
  await goList(page, 'casino');
  await openMode(page, 'Tide Pool');
  const c0 = await coins(page);
  await page.locator('.casino__go').click({ force: true });
  const blocked = await page.locator('.toast', { hasText: /Cool-off active/ }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.waitForTimeout(300);
  R.ok(`${vp}: a cool-off blocks a house bet and takes no coins`, blocked && (await coins(page)) === c0 && (await page.locator('.ball-tray .ball').count()) === 0, `${c0} -> ${await coins(page)}`);
  await back(page);
  await page.locator('.gamehead__back').click({ force: true });
  await page.locator('.home__level').waitFor();
  await goList(page, 'rooms');
  await openMode(page, 'Sunset Hall');
  // Let Tide Pool's toast expire first: locator.waitFor is strict and two identical toasts would throw.
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  await page.locator('.room__buy .btn-green').first().click({ force: true });
  const blockedRoom = await page.locator('.toast', { hasText: /Cool-off active/ }).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
  R.ok(`${vp}: a cool-off blocks buying room cards`, blockedRoom && (await coins(page)) === c0 && !/Starting in/.test(await text(page, '.room__count')), `toast=${blockedRoom} coins ${c0} -> ${await coins(page)} "${await text(page, '.room__count')}"`, page);
  await back(page);
  await page.locator('.gamehead__back').click({ force: true });
  await page.locator('.home__level').waitFor();
  await page.locator('.home__level').click({ force: true });
  await page.locator('[aria-label^="Level 1,"]').click({ force: true });
  await page.getByRole('button', { name: /Play/ }).last().click({ force: true });
  R.ok(`${vp}: the adventure stays open during a cool-off`, await page.locator('.bingo-btn').waitFor({ timeout: 5000 }).then(() => true, () => false));
  errorsOk(p, vp, 'limits (cool-off)');
  await p.close();

  const q = await player(browser, { viewport, seed: { onboarded: true, coins: 2000, limits: { reminderMinutes: 60, dailyLossLimit: 1000, coolOffUntil: 0 }, today: { day: localDay, wagered: 1000, won: 0 } } });
  await toHome(q.page, url);
  await openSetting(q.page, /Responsible play/);
  R.ok(`${vp}: the limits popup shows a −1,000 day and the 1,000 limit selected`, /net result: -1,000 coins/.test(await bodyText(q.page)) && (await q.page.locator('.chip-opt.is-on', { hasText: '1,000' }).count()) === 1, (await bodyText(q.page)).slice(0, 120));
  await closePopup(q.page);
  await goList(q.page, 'casino');
  await openMode(q.page, 'Keno Cove');
  await q.page.getByRole('button', { name: /Quick pick/ }).click({ force: true });
  const k0 = await coins(q.page);
  await q.page.getByRole('button', { name: /Draw 10/ }).click({ force: true });
  const lossBlocked = await q.page.locator('.toast', { hasText: /Daily loss limit reached/ }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  await q.page.waitForTimeout(300);
  R.ok(`${vp}: the daily loss limit blocks a bet once reached and takes no coins`, lossBlocked && (await coins(q.page)) === k0);
  errorsOk(q, vp, 'limits (daily loss)');
  await q.close();
}

const suites = { shell, popups, adventure, casino, rooms, limits };
for (const [vp, viewport] of VPS) {
  for (const name of SUITES) {
    console.log(`\n== ${vp} · ${name} ==`);
    try {
      await suites[name](vp, viewport);
    } catch (e) {
      R.ok(`${vp}: ${name} suite completed`, false, String(e.message || e).split('\n')[0]);
    }
  }
}
await browser.close();
server.close();
writeFileSync(`${OUT}results.json`, JSON.stringify(R.results, null, 2));
const failed = R.failures();
console.log(`\n${R.results.length - failed.length}/${R.results.length} checks passed${failed.length ? `; failing: ${failed.map((f) => f.name).join(' · ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
