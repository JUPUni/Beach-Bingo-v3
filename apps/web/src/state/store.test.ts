import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitSeed } from '@beach-bingo/engine';
import { migratePersisted, SPEND_CAP_DELAY_MS, STARTING_SAND, useGame, WASHINGTON_MESSAGE } from './store.ts';

const reset = () =>
  useGame.setState({
    sand: STARTING_SAND,
    coins: 0,
    table: 'sand',
    freeGames: 0,
    freeGameClaims: [],
    purchases: [],
    ageGate: null,
    region: null,
    pendingCoins: null,
    popup: null,
    linkedWallet: null,
    limits: { reminderMinutes: 60, dailyLossLimit: null, coolOffUntil: 0, dailySpendCap: null, spendCapRaise: null },
    today: { day: new Date().toLocaleDateString('en-CA'), wagered: { sand: 0, coins: 0 }, won: { sand: 0, coins: 0 }, bought: 0 },
  });

describe('game store', () => {
  beforeEach(reset);

  it('counts every navigation, so opening the screen already shown (Replay, Play again) is a new visit', () => {
    const before = useGame.getState().visit;
    useGame.getState().go({ name: 'adventure', level: 1 });
    useGame.getState().go({ name: 'adventure', level: 1 });
    expect(useGame.getState().visit).toBe(before + 2);
    expect(useGame.getState().screen).toEqual({ name: 'adventure', level: 1 });
    useGame.getState().go({ name: 'game', mode: 'sunsetHall' });
    useGame.getState().go({ name: 'game', mode: 'sunsetHall' });
    expect(useGame.getState().visit).toBe(before + 4);
  });

  it('rotating seeds reveals the old seed next to the commitment it was played under', () => {
    const { serverSeed, clientSeed, commitment } = useGame.getState().fairness;
    useGame.getState().commitFairNonce(4);
    useGame.getState().rotateSeeds();
    const { fairness } = useGame.getState();
    expect(fairness.previous).toEqual({ serverSeed, clientSeed, lastNonce: 4, commitment });
    expect(commitSeed(fairness.previous!.serverSeed)).toBe(fairness.previous!.commitment);
    expect(fairness.commitment).not.toBe(commitment);
    expect(fairness.serverSeed).not.toBe(serverSeed);
    expect(fairness.nonce).toBe(0);
  });
});

describe('the two currencies', () => {
  beforeEach(reset);

  it('starts every player on the SAND table with 1,000 SAND and no coins', () => {
    const s = useGame.getState();
    expect([s.table, s.sand, s.coins, s.freeGames]).toEqual(['sand', STARTING_SAND, 0, 0]);
  });

  it('migrates a v1 save: the free coins become SAND, coins start at 0, the jackpot and the day move to the SAND side', () => {
    const day = new Date().toLocaleDateString('en-CA');
    const v1 = { coins: 1234, jackpot: { pool: 7200, lastWonDay: day }, today: { day, wagered: 300, won: 120 }, limits: { reminderMinutes: 30, dailyLossLimit: 1000, coolOffUntil: 0 } };
    const p = migratePersisted(v1, 1);
    expect(p.sand).toBe(1234);
    expect(p.coins).toBe(0);
    expect(p).not.toHaveProperty('jackpot');
    expect((p.jackpots as { sand: { pool: number }; coins: { pool: number } }).sand.pool).toBe(7200);
    expect((p.jackpots as { coins: { pool: number } }).coins.pool).toBe(5000);
    expect(p.today).toEqual({ day, wagered: { sand: 300, coins: 0 }, won: { sand: 120, coins: 0 }, bought: 0 });
    expect(p.limits).toEqual({ reminderMinutes: 30, dailyLossLimit: 1000, coolOffUntil: 0, dailySpendCap: null, spendCapRaise: null });
    // A v2 save passes through untouched.
    expect(migratePersisted({ sand: 5, coins: 9 }, 2)).toEqual({ sand: 5, coins: 9 });
  });

  it('migrates through the persist layer on first load', async () => {
    const day = new Date().toLocaleDateString('en-CA');
    const blob: Record<string, string> = {
      'beach-bingo': JSON.stringify({ state: { coins: 777, jackpot: { pool: 6000, lastWonDay: day }, today: { day, wagered: 0, won: 0 } }, version: 1 }),
    };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => blob[k] ?? null,
      setItem: (k: string, v: string) => {
        blob[k] = v;
      },
      removeItem: (k: string) => {
        delete blob[k];
      },
    });
    try {
      await useGame.persist.rehydrate();
      const s = useGame.getState();
      expect(s.sand).toBe(777);
      expect(s.coins).toBe(0);
      expect(s.table).toBe('sand');
      expect(s.jackpots.sand.pool).toBe(6000);
      expect(JSON.parse(blob['beach-bingo']!).version).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('charges and credits the active table, and an explicit one', () => {
    const s = useGame.getState();
    expect(s.charge(100, { wager: true })).toBe(true);
    expect(useGame.getState().sand).toBe(STARTING_SAND - 100);
    expect(useGame.getState().coins).toBe(0);
    expect(useGame.getState().today.wagered).toEqual({ sand: 100, coins: 0 });
    useGame.getState().recordWin(250);
    expect(useGame.getState().sand).toBe(STARTING_SAND + 150);
    expect(useGame.getState().today.won.sand).toBe(250);
    // Coins are empty: a coin charge fails and takes nothing.
    expect(useGame.getState().charge(10, { table: 'coins' })).toBe(false);
    useGame.getState().credit(500, { table: 'coins' });
    expect(useGame.getState().coins).toBe(500);
    expect(useGame.getState().charge(60, { wager: true, table: 'coins' })).toBe(true);
    useGame.getState().refund(10, { table: 'coins' });
    expect(useGame.getState().coins).toBe(450);
    expect(useGame.getState().today.wagered.coins).toBe(50);
    expect(useGame.getState().sand).toBe(STARTING_SAND + 150);
    expect(useGame.getState().balance('coins')).toBe(450);
    expect(useGame.getState().balance()).toBe(STARTING_SAND + 150);
  });

  it('applies the daily loss limit per table', () => {
    useGame.getState().setLimits({ dailyLossLimit: 100 });
    useGame.getState().credit(1000, { table: 'coins' });
    expect(useGame.getState().charge(100, { wager: true })).toBe(true);
    expect(useGame.getState().wagerBlockedReason()).toMatch(/Daily loss limit/);
    expect(useGame.getState().charge(10, { wager: true })).toBe(false);
    expect(useGame.getState().wagerBlockedReason('coins')).toBeNull();
    expect(useGame.getState().charge(10, { wager: true, table: 'coins' })).toBe(true);
  });

  it('the free money stays SAND: faucet, tasks, levels, chest and the Seeker perk', () => {
    useGame.setState({ faucetAt: 0, keys: 3, tasks: { ...useGame.getState().tasks, progress: { daub: 60, bingo: 0, modes: 0, spins: 0 }, claimed: [] } });
    expect(useGame.getState().claimFaucet()).toBe(true);
    expect(useGame.getState().claimTask('daub')).toBe(true);
    useGame.getState().completeLevel(1, 3, 60);
    const chest = useGame.getState().openChest();
    expect(useGame.getState().claimSeekerPerk('mint-1')).toBe(true);
    expect(useGame.getState().coins).toBe(0);
    expect(useGame.getState().sand).toBe(STARTING_SAND + 500 + 150 + 60 + chest!.sand + 2500);
  });
});

describe('the coin gate', () => {
  beforeEach(reset);

  it('asks for the age declaration once, then flips the table and shows the shop to a player with no coins', () => {
    const s = useGame.getState();
    expect(s.coinsReady()).toBe(false);
    expect(s.requestCoins('table')).toBe('gate');
    expect(useGame.getState().popup).toBe('age');
    expect(useGame.getState().table).toBe('sand');
    useGame.getState().confirmAge();
    const after = useGame.getState();
    expect(after.ageGate?.confirmedAt).toBeGreaterThan(0);
    expect(after.table).toBe('coins');
    expect(after.popup).toBe('shop');
    expect(after.pendingCoins).toBeNull();
    // The second time there is no gate.
    useGame.getState().setTable('sand');
    useGame.getState().closePopup();
    expect(useGame.getState().requestCoins('shop')).toBe('done');
    expect(useGame.getState().popup).toBe('shop');
  });

  it('blocks Washington State with one line and keeps SAND play open; an unknown region fails open', () => {
    useGame.getState().setRegion({ country: 'US', region: 'WA' });
    expect(useGame.getState().coinsBlockedReason()).toBe(WASHINGTON_MESSAGE);
    expect(useGame.getState().requestCoins('table')).toBe('blocked');
    expect(useGame.getState().popup).toBeNull();
    expect(useGame.getState().table).toBe('sand');
    useGame.getState().confirmAge();
    expect(useGame.getState().coinsReady()).toBe(false);
    useGame.getState().setTable('coins');
    expect(useGame.getState().table).toBe('sand');
    expect(useGame.getState().charge(10, { wager: true })).toBe(true);
    useGame.getState().setRegion({ country: null, region: null });
    expect(useGame.getState().coinsBlockedReason()).toBeNull();
    expect(useGame.getState().coinsReady()).toBe(true);
    useGame.getState().setRegion({ country: 'US', region: 'CA' });
    expect(useGame.getState().coinsReady()).toBe(true);
  });

  it('SAND never needs the gate', () => {
    expect(useGame.getState().ageGate).toBeNull();
    expect(useGame.getState().charge(50, { wager: true })).toBe(true);
    useGame.getState().recordWin(80);
    expect(useGame.getState().sand).toBe(STARTING_SAND + 30);
  });
});

describe('the free game ticket', () => {
  beforeEach(reset);

  it('is claimed once per device, once more per linked wallet, and pays one coin-table entry at the base price', () => {
    expect(useGame.getState().canClaimFreeGame()).toBe(true);
    expect(useGame.getState().claimFreeGame()).toBe(true);
    expect(useGame.getState().freeGames).toBe(1);
    expect(useGame.getState().claimFreeGame()).toBe(false);
    useGame.getState().setLinkedWallet('WaLLet1111111111111111111111111111111111111');
    expect(useGame.getState().claimFreeGame()).toBe(true);
    expect(useGame.getState().claimFreeGame()).toBe(false);
    expect(useGame.getState().freeGames).toBe(2);
    expect(useGame.getState().freeGameClaims).toEqual(['device', 'WaLLet1111111111111111111111111111111111111']);

    // On the SAND table the ticket is not used.
    expect(useGame.getState().freeGameCovers(25, 25)).toBe(false);
    expect(useGame.getState().charge(25, { wager: true, base: 25 })).toBe(true);
    expect(useGame.getState().freeGames).toBe(2);
    expect(useGame.getState().sand).toBe(STARTING_SAND - 25);

    useGame.setState({ table: 'coins', coins: 0 });
    expect(useGame.getState().freeGameCovers(25, 25)).toBe(true);
    expect(useGame.getState().freeGameCovers(50, 25)).toBe(false);
    // Two cards are not the base entry: no ticket, no coins, refused.
    expect(useGame.getState().charge(50, { wager: true, base: 25 })).toBe(false);
    expect(useGame.getState().charge(25, { wager: true, base: 25 })).toBe(true);
    expect(useGame.getState().freeGames).toBe(1);
    expect(useGame.getState().coins).toBe(0);
    expect(useGame.getState().today.wagered.coins).toBe(0);
    // The prize is paid in coins as usual.
    useGame.getState().recordWin(95);
    expect(useGame.getState().coins).toBe(95);
    // A ticket never covers a plain (non-wager) charge.
    expect(useGame.getState().charge(25, { base: 25 })).toBe(true);
    expect(useGame.getState().coins).toBe(70);
    expect(useGame.getState().freeGames).toBe(1);
  });
});

describe('the Coin Shop ledger', () => {
  beforeEach(reset);
  afterEach(() => vi.useRealTimers());

  it('credits a purchase once, records it, and refuses it during a cool-off', () => {
    const p = { signature: 'sig-1', pack: 'pack-5k', mint: 'SKR', coins: 5000, at: Date.now() };
    expect(useGame.getState().creditPurchase(p)).toBe(true);
    expect(useGame.getState().creditPurchase(p)).toBe(false);
    expect(useGame.getState().coins).toBe(5000);
    expect(useGame.getState().purchases).toEqual([p]);
    expect(useGame.getState().today.bought).toBe(5000);
    useGame.getState().setLimits({ coolOffUntil: Date.now() + 3600_000 });
    expect(useGame.getState().purchaseBlockedReason(5000)).toMatch(/break/);
    expect(useGame.getState().creditPurchase({ ...p, signature: 'sig-2' })).toBe(false);
    expect(useGame.getState().coins).toBe(5000);
  });

  it('lowers the daily spend cap at once and raises it after a day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00'));
    expect(useGame.getState().setSpendCap(15000)).toBe('now');
    expect(useGame.getState().spendCap()).toBe(15000);
    expect(useGame.getState().setSpendCap(5000)).toBe('now');
    expect(useGame.getState().spendCap()).toBe(5000);
    expect(useGame.getState().setSpendCap(40000)).toBe('later');
    expect(useGame.getState().spendCap()).toBe(5000);
    expect(useGame.getState().purchaseBlockedReason(5000)).toBeNull();
    expect(useGame.getState().purchaseBlockedReason(15000)).toMatch(/cap of 5,000/);
    expect(useGame.getState().creditPurchase({ signature: 's1', pack: 'pack-15k', mint: 'SOL', coins: 15000, at: Date.now() })).toBe(false);
    expect(useGame.getState().creditPurchase({ signature: 's2', pack: 'pack-5k', mint: 'SOL', coins: 5000, at: Date.now() })).toBe(true);
    expect(useGame.getState().purchaseBlockedReason(5000)).toMatch(/cap/);
    vi.advanceTimersByTime(SPEND_CAP_DELAY_MS + 1);
    expect(useGame.getState().spendCap()).toBe(40000);
    expect(useGame.getState().limits.spendCapRaise).toBeNull();
    // Off is the highest value: a raise too.
    expect(useGame.getState().setSpendCap(null)).toBe('later');
    expect(useGame.getState().spendCap()).toBe(40000);
  });
});
