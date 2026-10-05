import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import {
  commitSeed,
  createClientSeed,
  createServerSeed,
  type BoosterId,
  type FairSeed,
  type ModeId,
  type RoomPresetId,
} from '@beach-bingo/engine';

export type Screen =
  | { name: 'splash' }
  | { name: 'home' }
  | { name: 'map'; page?: number }
  | { name: 'adventure'; level: number; seagull?: boolean; sun?: boolean }
  | { name: 'casino' }
  | { name: 'rooms' }
  | { name: 'game'; mode: ModeId }
  /** A live room: the host picks the hall, guests learn it from the host. */
  | { name: 'live'; code: string; host: boolean; preset?: RoomPresetId };

export type PopupName = 'settings' | 'profile' | 'tasks' | 'wallet' | 'fairness' | 'limits' | 'credits' | 'chest' | 'faucet' | 'shop' | 'age';

export type TaskId = 'daub' | 'bingo' | 'modes' | 'spins';

/**
 * The two currencies. SAND is free play money: the tide, the daily tasks, the adventure, the
 * chest and the Seeker perk all pay SAND, and it is never bought or sold. Coins come only from
 * the Coin Shop and promo grants; they have no cash value, cannot be sold, transferred or
 * refunded, and never leave the game. Every mode plays on either: the `table` picks which
 * ledger a stake comes from and a prize goes to.
 */
export type Table = 'sand' | 'coins';
export const TABLES: readonly Table[] = ['sand', 'coins'];
export const TABLE_NAME: Record<Table, string> = { sand: 'SAND', coins: 'coins' };

export interface TaskDef {
  id: TaskId;
  label: string;
  goal: number;
  /** SAND. */
  reward: number;
}

export const DAILY_TASKS: readonly TaskDef[] = [
  { id: 'daub', label: 'Daub 60 numbers', goal: 60, reward: 150 },
  { id: 'bingo', label: 'Shout 3 BINGOs', goal: 3, reward: 200 },
  { id: 'modes', label: 'Play 3 different games', goal: 3, reward: 250 },
  { id: 'spins', label: 'Play 10 house rounds', goal: 10, reward: 150 },
];

export const STARTING_SAND = 1000;
export const FAUCET_SAND = 500;
export const FAUCET_COOLDOWN_MS = 4 * 60 * 60 * 1000;
export const CHEST_KEYS = 3;
export const JACKPOT_SEED = 5000;
export const SEEKER_PERK_SAND = 2500;
/** The wallet popup (solana/, not edited here) still imports this name; the perk pays SAND. */
export const SEEKER_PERK_COINS = SEEKER_PERK_SAND;
/** A raised Coin Shop cap takes effect this long after it is chosen; a lowered one at once. */
export const SPEND_CAP_DELAY_MS = 24 * 60 * 60 * 1000;
export const SPEND_CAP_OPTIONS: readonly (number | null)[] = [null, 5000, 15000, 40000];
/** The one line a player in Washington State sees instead of the shop or a coin table. */
export const WASHINGTON_MESSAGE = 'Coin tables and the Coin Shop are not available in Washington State. SAND play is open.';
export const FOLLOW_URL = 'https://x.com/intent/follow?screen_name=mostlyjola';

interface Settings {
  sound: boolean;
  music: boolean;
  voice: boolean;
  haptics: boolean;
  reduceMotion: boolean;
}

interface Limits {
  /** Reminder after this many minutes of continuous play (null = off). */
  reminderMinutes: number | null;
  /** Daily net-loss limit on the active table across wager modes (null = off). */
  dailyLossLimit: number | null;
  /** Cool-off: wager modes and the shop locked until this timestamp. */
  coolOffUntil: number;
  /** Coins the shop may sell per day (null = no cap). */
  dailySpendCap: number | null;
  /** A raise of the cap waits a day; `value` applies from `at`. */
  spendCapRaise: { value: number | null; at: number } | null;
}

interface FairnessState {
  serverSeed: string;
  commitment: string;
  clientSeed: string;
  nonce: number;
  /** The retired seed, revealed, with the commitment that was shown while it was in use (absent in states saved before it was recorded). */
  previous: { serverSeed: string; clientSeed: string; lastNonce: number; commitment?: string } | null;
}

interface Jackpot {
  pool: number;
  lastWonDay: string;
}

/** Today's wagers and prizes per table, and the coins bought today. */
interface DayLedger {
  day: string;
  wagered: Record<Table, number>;
  won: Record<Table, number>;
  bought: number;
}

/** A Coin Shop purchase, as the chain confirmed it (or the dev stub pretended to). */
export interface Purchase {
  signature: string;
  pack: string;
  mint: string;
  coins: number;
  at: number;
}

/** What `/api/geo` said about this session; both null when it could not tell. */
export interface Region {
  country: string | null;
  region: string | null;
}

export interface LedgerOpts {
  /** Count it as a wager (limits, the daily ledger). */
  wager?: boolean;
  /** The ledger to use; the active table when omitted. */
  table?: Table;
  /** The mode's base price: a free-game ticket covers a coin-table charge of exactly this amount. */
  base?: number;
}

export interface GameState {
  sand: number;
  coins: number;
  /** Which currency the games play with right now. */
  table: Table;
  keys: number;
  profile: { name: string; avatar: string };
  settings: Settings;
  limits: Limits;
  /** Stars per adventure level id. */
  stars: Record<number, number>;
  boosters: Record<BoosterId, number>;
  tasks: { day: string; progress: Record<TaskId, number>; claimed: TaskId[]; modesPlayed: ModeId[] };
  today: DayLedger;
  stats: { rounds: number; bingos: number; biggestWin: number };
  faucetAt: number;
  /** Practice-room progressive jackpots, one per table. */
  jackpots: Record<Table, Jackpot>;
  fairness: FairnessState;
  onboarded: boolean;
  /** Wallet linked via SIWS. */
  linkedWallet: string | null;
  /** Seeker Genesis Token mints that already claimed the Seeker perk on this device. */
  seekerPerkMints: string[];
  /** The 18+ and not-in-Washington declaration that opens coin tables and the shop; SAND never asks. */
  ageGate: { confirmedAt: number } | null;
  /** Free Game tickets held: each pays one coin-table entry at the mode's base price. */
  freeGames: number;
  /** Who already claimed the follow reward here: 'device', or a linked wallet's address. */
  freeGameClaims: string[];
  purchases: Purchase[];

  // Session (not persisted)
  screen: Screen;
  /** Counts navigations, so going again to the screen already shown (Replay, Play again) mounts it afresh. */
  visit: number;
  popup: PopupName | null;
  sessionStart: number;
  /** A room code from an invite link, honoured once the player leaves the splash. */
  pendingJoin: string | null;
  /** The region check's answer (null until it answered; unknown reads as both fields null). */
  region: Region | null;
  /** What to do once the age gate is confirmed. */
  pendingCoins: 'shop' | 'table' | null;
  /** The wallet holds SKR (set by the chain shop); the shop preselects SKR. */
  skrReady: boolean;
  /** The follow link was opened this session; the claim unlocks when the page comes back. */
  follow: 'idle' | 'opened' | 'returned';

  go(screen: Screen): void;
  openPopup(popup: PopupName): void;
  closePopup(): void;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  setLimits(limits: Partial<Pick<Limits, 'reminderMinutes' | 'dailyLossLimit' | 'coolOffUntil'>>): void;
  /** Lower the shop cap at once; a raise applies after SPEND_CAP_DELAY_MS. */
  setSpendCap(value: number | null): 'now' | 'later';
  /** The cap in force right now (a due raise is applied as it is read). */
  spendCap(): number | null;
  setProfile(profile: Partial<GameState['profile']>): void;
  balance(table?: Table): number;
  /** Take `amount` from a ledger. False when unaffordable or, for a wager, blocked by the limits. */
  charge(amount: number, opts?: LedgerOpts): boolean;
  /** Put `amount` on a ledger (a grant, a prize that is not a wager's). */
  credit(amount: number, opts?: { table?: Table }): void;
  /** Record winnings from a wager round. */
  recordWin(amount: number, opts?: { table?: Table }): void;
  /** Give back a stake that was never played (a live round that started without these cards). */
  refund(amount: number, opts?: { table?: Table }): void;
  /** True when a free-game ticket would pay this charge (a coin-table entry at the base price). */
  freeGameCovers(amount: number, base?: number, table?: Table): boolean;
  setPendingJoin(code: string | null): void;
  claimFaucet(): boolean;
  completeLevel(levelId: number, stars: number, sand: number): { newKey: boolean };
  openChest(): { sand: number; booster: BoosterId } | null;
  addBooster(id: BoosterId, count: number): void;
  consumeBooster(id: BoosterId): boolean;
  track(task: TaskId, amount?: number): void;
  playedMode(mode: ModeId): void;
  claimTask(task: TaskId): boolean;
  /** The next round's seed. Reading it changes nothing; commitFairNonce marks it used. */
  peekFairSeed(): FairSeed & { commitment: string };
  /** Mark `nonce` as used, so the next round gets nonce + 1. Never moves the counter back. */
  commitFairNonce(nonce: number): void;
  setClientSeed(seed: string): void;
  rotateSeeds(): void;
  wagerBlockedReason(table?: Table): string | null;
  contributeJackpot(amount: number, table?: Table): void;
  resetJackpot(table?: Table): void;
  setLinkedWallet(address: string | null): void;
  claimSeekerPerk(mint: string): boolean;

  /* ---------- Coins: the gate, the shop, the free game ---------- */
  setRegion(region: Region): void;
  setSkrReady(ready: boolean): void;
  /** The one-line reason coin tables and the shop are closed here, or null. */
  coinsBlockedReason(): string | null;
  /** Age confirmed and the region not blocked: coin tables and the shop may open. */
  coinsReady(): boolean;
  /**
   * Open the shop, or move play to the coins table: at once when the gate is passed ('done'),
   * through the age popup first ('gate'), or not at all in a blocked region ('blocked').
   */
  requestCoins(intent: 'shop' | 'table'): 'done' | 'gate' | 'blocked';
  /** The player confirmed 18+ and not in Washington; carries out the pending request. */
  confirmAge(): void;
  /** SAND always; coins only once the gate is passed. */
  setTable(table: Table): void;
  /** Credit a confirmed purchase. False when a cool-off is on, the cap would be passed, or it was already credited. */
  creditPurchase(purchase: Purchase): boolean;
  purchaseBlockedReason(coins: number): string | null;
  setFollow(state: GameState['follow']): void;
  canClaimFreeGame(): boolean;
  claimFreeGame(): boolean;
}

const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* storage unavailable (private mode) — play on without saving */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

const localDay = () => new Date().toLocaleDateString('en-CA');

function freshFairness(clientSeed = createClientSeed()): FairnessState {
  const serverSeed = createServerSeed();
  return { serverSeed, commitment: commitSeed(serverSeed), clientSeed, nonce: 0, previous: null };
}

const emptyTasks = () => ({
  day: localDay(),
  progress: { daub: 0, bingo: 0, modes: 0, spins: 0 },
  claimed: [] as TaskId[],
  modesPlayed: [] as ModeId[],
});

const emptyDay = (): DayLedger => ({ day: localDay(), wagered: { sand: 0, coins: 0 }, won: { sand: 0, coins: 0 }, bought: 0 });
const freshJackpot = (): Jackpot => ({ pool: JACKPOT_SEED, lastWonDay: localDay() });
const todayOf = (s: Pick<GameState, 'today'>): DayLedger => (s.today.day === localDay() ? s.today : emptyDay());
const keyOf = (table: Table) => table;
/** A cap of null is "no cap": the highest value there is. */
const capLower = (next: number | null, current: number | null) => next !== null && (current === null || next < current);

/**
 * Saved states from before the two currencies: `coins` was free money, so it becomes SAND and
 * coins start at 0; the one jackpot and the day's ledger become the SAND side of each.
 */
export function migratePersisted(persisted: unknown, version: number): Record<string, unknown> {
  const p = { ...(persisted as Record<string, unknown>) };
  if (version < 2) {
    const oldCoins = typeof p.coins === 'number' ? p.coins : 0;
    p.sand = (typeof p.sand === 'number' ? p.sand : 0) + oldCoins;
    p.coins = 0;
    const jackpot = p.jackpot as Jackpot | undefined;
    p.jackpots = { sand: jackpot && typeof jackpot.pool === 'number' ? jackpot : freshJackpot(), coins: freshJackpot() };
    delete p.jackpot;
    const today = p.today as { day?: string; wagered?: number; won?: number } | undefined;
    if (today && typeof today.day === 'string') {
      p.today = { day: today.day, wagered: { sand: today.wagered ?? 0, coins: 0 }, won: { sand: today.won ?? 0, coins: 0 }, bought: 0 };
    } else {
      delete p.today;
    }
    p.limits = { dailySpendCap: null, spendCapRaise: null, ...((p.limits as object | undefined) ?? {}) };
  }
  return p;
}

export const useGame = create<GameState>()(
  persist(
    (set, get) => ({
      sand: STARTING_SAND,
      coins: 0,
      table: 'sand',
      keys: 0,
      profile: { name: 'Beachcomber', avatar: '🦀' },
      settings: { sound: true, music: true, voice: true, haptics: true, reduceMotion: false },
      limits: { reminderMinutes: 60, dailyLossLimit: null, coolOffUntil: 0, dailySpendCap: null, spendCapRaise: null },
      stars: {},
      boosters: { seagull: 1, crab: 2, wave: 1, sun: 1 },
      tasks: emptyTasks(),
      today: emptyDay(),
      stats: { rounds: 0, bingos: 0, biggestWin: 0 },
      faucetAt: 0,
      jackpots: { sand: freshJackpot(), coins: freshJackpot() },
      fairness: freshFairness(),
      onboarded: false,
      linkedWallet: null,
      seekerPerkMints: [],
      ageGate: null,
      freeGames: 0,
      freeGameClaims: [],
      purchases: [],

      screen: { name: 'splash' },
      visit: 0,
      popup: null,
      sessionStart: Date.now(),
      pendingJoin: null,
      region: null,
      pendingCoins: null,
      skrReady: false,
      follow: 'idle',

      go: (screen) => set((s) => ({ screen, popup: null, visit: s.visit + 1 })),
      openPopup: (popup) => set({ popup }),
      closePopup: () => set({ popup: null }),
      setSetting: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setLimits: (limits) => set((s) => ({ limits: { ...s.limits, ...limits } })),
      setSpendCap: (value) => {
        const current = get().spendCap();
        if (capLower(value, current)) {
          set((s) => ({ limits: { ...s.limits, dailySpendCap: value, spendCapRaise: null } }));
          return 'now';
        }
        if (value === current) {
          set((s) => ({ limits: { ...s.limits, spendCapRaise: null } }));
          return 'now';
        }
        set((s) => ({ limits: { ...s.limits, spendCapRaise: { value, at: Date.now() + SPEND_CAP_DELAY_MS } } }));
        return 'later';
      },
      spendCap: () => {
        const { limits } = get();
        if (limits.spendCapRaise && limits.spendCapRaise.at <= Date.now()) {
          const value = limits.spendCapRaise.value;
          set({ limits: { ...limits, dailySpendCap: value, spendCapRaise: null } });
          return value;
        }
        return limits.dailySpendCap;
      },
      setProfile: (profile) => set((s) => ({ profile: { ...s.profile, ...profile } })),
      balance: (table) => get()[keyOf(table ?? get().table)],

      charge: (amount, opts) => {
        const s = get();
        const table = opts?.table ?? s.table;
        if (amount <= 0) return true;
        if (opts?.wager && s.wagerBlockedReason(table)) return false;
        if (opts?.wager && s.freeGameCovers(amount, opts.base, table)) {
          set({ freeGames: s.freeGames - 1 });
          return true;
        }
        if (s[keyOf(table)] < amount) return false;
        const today = todayOf(s);
        set({
          [keyOf(table)]: s[keyOf(table)] - amount,
          today: opts?.wager ? { ...today, wagered: { ...today.wagered, [table]: today.wagered[table] + amount } } : today,
        });
        return true;
      },

      credit: (amount, opts) =>
        set((s) => {
          const table = opts?.table ?? s.table;
          return { [keyOf(table)]: s[keyOf(table)] + Math.max(0, Math.floor(amount)) };
        }),

      recordWin: (amount, opts) =>
        set((s) => {
          const table = opts?.table ?? s.table;
          const today = todayOf(s);
          return {
            [keyOf(table)]: s[keyOf(table)] + amount,
            today: { ...today, won: { ...today.won, [table]: today.won[table] + amount } },
            stats: { ...s.stats, rounds: s.stats.rounds + 1, biggestWin: Math.max(s.stats.biggestWin, amount) },
          };
        }),

      refund: (amount, opts) =>
        set((s) => {
          if (amount <= 0) return s;
          const table = opts?.table ?? s.table;
          const today = todayOf(s);
          return {
            [keyOf(table)]: s[keyOf(table)] + Math.floor(amount),
            today: { ...today, wagered: { ...today.wagered, [table]: Math.max(0, today.wagered[table] - amount) } },
          };
        }),

      freeGameCovers: (amount, base, table?: Table) => {
        const s = get();
        return (table ?? s.table) === 'coins' && s.freeGames > 0 && base !== undefined && amount === base;
      },
      setPendingJoin: (pendingJoin) => set({ pendingJoin }),

      claimFaucet: () => {
        const s = get();
        if (Date.now() - s.faucetAt < FAUCET_COOLDOWN_MS) return false;
        set({ sand: s.sand + FAUCET_SAND, faucetAt: Date.now() });
        return true;
      },

      completeLevel: (levelId, stars, sand) => {
        const s = get();
        const before = s.stars[levelId] ?? 0;
        const newKey = stars === 3 && before < 3;
        set({
          stars: { ...s.stars, [levelId]: Math.max(before, stars) },
          sand: s.sand + sand,
          keys: s.keys + (newKey ? 1 : 0),
          stats: { ...s.stats, bingos: s.stats.bingos + 1 },
        });
        return { newKey };
      },

      openChest: () => {
        const s = get();
        if (s.keys < CHEST_KEYS) return null;
        const boosters: BoosterId[] = ['seagull', 'crab', 'wave', 'sun'];
        const booster = boosters[Math.floor(Math.random() * boosters.length)]!;
        const sand = 400 + Math.floor(Math.random() * 5) * 100;
        set({
          keys: s.keys - CHEST_KEYS,
          sand: s.sand + sand,
          boosters: { ...s.boosters, [booster]: s.boosters[booster] + 1 },
        });
        return { sand, booster };
      },

      addBooster: (id, count) => set((s) => ({ boosters: { ...s.boosters, [id]: s.boosters[id] + count } })),
      consumeBooster: (id) => {
        const s = get();
        if (s.boosters[id] <= 0) return false;
        set({ boosters: { ...s.boosters, [id]: s.boosters[id] - 1 } });
        return true;
      },

      track: (task, amount = 1) =>
        set((s) => {
          const tasks = s.tasks.day === localDay() ? s.tasks : emptyTasks();
          return { tasks: { ...tasks, progress: { ...tasks.progress, [task]: tasks.progress[task] + amount } } };
        }),

      playedMode: (mode) =>
        set((s) => {
          const tasks = s.tasks.day === localDay() ? s.tasks : emptyTasks();
          if (tasks.modesPlayed.includes(mode)) return { tasks };
          const modesPlayed = [...tasks.modesPlayed, mode];
          return { tasks: { ...tasks, modesPlayed, progress: { ...tasks.progress, modes: modesPlayed.length } } };
        }),

      claimTask: (task) => {
        const s = get();
        const def = DAILY_TASKS.find((t) => t.id === task);
        if (!def || s.tasks.day !== localDay() || s.tasks.claimed.includes(task)) return false;
        if (s.tasks.progress[task] < def.goal) return false;
        set({ sand: s.sand + def.reward, tasks: { ...s.tasks, claimed: [...s.tasks.claimed, task] } });
        return true;
      },

      peekFairSeed: () => {
        const f = get().fairness;
        return { serverSeed: f.serverSeed, clientSeed: f.clientSeed, nonce: f.nonce, commitment: f.commitment };
      },

      commitFairNonce: (nonce) =>
        set((s) => (s.fairness.nonce > nonce ? s : { fairness: { ...s.fairness, nonce: nonce + 1 } })),

      setClientSeed: (clientSeed) => set((s) => ({ fairness: { ...s.fairness, clientSeed } })),

      rotateSeeds: () =>
        set((s) => {
          const next = freshFairness(s.fairness.clientSeed);
          return {
            fairness: {
              ...next,
              previous: {
                serverSeed: s.fairness.serverSeed,
                clientSeed: s.fairness.clientSeed,
                lastNonce: s.fairness.nonce - 1,
                commitment: s.fairness.commitment,
              },
            },
          };
        }),

      contributeJackpot: (amount, table) =>
        set((s) => {
          const t = table ?? s.table;
          return { jackpots: { ...s.jackpots, [t]: { ...s.jackpots[t], pool: s.jackpots[t].pool + Math.max(0, amount) } } };
        }),
      resetJackpot: (table) => set((s) => ({ jackpots: { ...s.jackpots, [table ?? s.table]: freshJackpot() } })),
      setLinkedWallet: (linkedWallet) => set({ linkedWallet }),
      claimSeekerPerk: (mint) => {
        const s = get();
        if (s.seekerPerkMints.includes(mint)) return false;
        set({
          seekerPerkMints: [...s.seekerPerkMints, mint],
          sand: s.sand + SEEKER_PERK_SAND,
          boosters: { ...s.boosters, seagull: s.boosters.seagull + 2, crab: s.boosters.crab + 2, wave: s.boosters.wave + 2, sun: s.boosters.sun + 2 },
        });
        return true;
      },

      wagerBlockedReason: (table) => {
        const s = get();
        if (s.limits.coolOffUntil > Date.now()) {
          return `Cool-off active until ${new Date(s.limits.coolOffUntil).toLocaleString()}`;
        }
        const t = table ?? s.table;
        const today = todayOf(s);
        if (s.limits.dailyLossLimit !== null && today.wagered[t] - today.won[t] >= s.limits.dailyLossLimit) {
          return 'Daily loss limit reached — come back tomorrow.';
        }
        return null;
      },

      /* ---------- Coins: the gate, the shop, the free game ---------- */
      setRegion: (region) => set({ region }),
      setSkrReady: (skrReady) => set({ skrReady }),
      coinsBlockedReason: () => {
        const r = get().region;
        // Only a positive answer blocks: an unknown region (no Vercel headers in dev, the devnet
        // build, a failed call) lets the self-declaration stand on its own. Documented in docs/GAME_MODES.md.
        return r && r.country === 'US' && r.region === 'WA' ? WASHINGTON_MESSAGE : null;
      },
      coinsReady: () => get().ageGate !== null && get().coinsBlockedReason() === null,
      requestCoins: (intent) => {
        const s = get();
        if (s.coinsBlockedReason()) return 'blocked';
        if (!s.ageGate) {
          set({ pendingCoins: intent, popup: 'age' });
          return 'gate';
        }
        if (intent === 'shop') {
          set({ popup: 'shop' });
        } else {
          // A player with nothing to play with sees the shop, not a dead end.
          set({ table: 'coins', popup: s.coins === 0 && s.freeGames === 0 ? 'shop' : s.popup === 'age' ? null : s.popup });
        }
        return 'done';
      },
      confirmAge: () => {
        const pending = get().pendingCoins;
        set({ ageGate: { confirmedAt: Date.now() }, pendingCoins: null, popup: null });
        if (pending) get().requestCoins(pending);
      },
      setTable: (table) => {
        if (table === 'coins' && !get().coinsReady()) return;
        set({ table });
      },
      purchaseBlockedReason: (coins) => {
        const s = get();
        if (s.limits.coolOffUntil > Date.now()) return 'The Coin Shop is closed during your break.';
        const cap = s.spendCap();
        if (cap !== null && todayOf(s).bought + coins > cap) return `That would pass today's cap of ${cap.toLocaleString('en-US')} coins.`;
        return null;
      },
      creditPurchase: (purchase) => {
        const s = get();
        if (s.purchases.some((p) => p.signature === purchase.signature)) return false;
        if (s.purchaseBlockedReason(purchase.coins)) return false;
        const today = todayOf(s);
        set({
          coins: s.coins + purchase.coins,
          purchases: [purchase, ...s.purchases].slice(0, 50),
          today: { ...today, bought: today.bought + purchase.coins },
        });
        return true;
      },
      setFollow: (follow) => set({ follow }),
      canClaimFreeGame: () => {
        const s = get();
        // Once per device, and once per linked wallet: the first claim here is always open, a
        // later one needs a linked wallet that has not claimed yet. The follow itself cannot be
        // verified without the X API and a server (docs/PRODUCTION.md), so the reward is one
        // ticket, not coins.
        if (s.freeGameClaims.length === 0) return true;
        return s.linkedWallet !== null && !s.freeGameClaims.includes(s.linkedWallet);
      },
      claimFreeGame: () => {
        const s = get();
        if (!s.canClaimFreeGame()) return false;
        set({ freeGames: s.freeGames + 1, freeGameClaims: [...s.freeGameClaims, s.linkedWallet ?? 'device'], follow: 'idle' });
        return true;
      },
    }),
    {
      name: 'beach-bingo',
      version: 2,
      storage: createJSONStorage(() => safeStorage),
      migrate: migratePersisted,
      partialize: (s) => ({
        sand: s.sand,
        coins: s.coins,
        table: s.table,
        keys: s.keys,
        profile: s.profile,
        settings: s.settings,
        limits: s.limits,
        stars: s.stars,
        boosters: s.boosters,
        tasks: s.tasks,
        today: s.today,
        stats: s.stats,
        faucetAt: s.faucetAt,
        jackpots: s.jackpots,
        fairness: s.fairness,
        onboarded: s.onboarded,
        linkedWallet: s.linkedWallet,
        seekerPerkMints: s.seekerPerkMints,
        ageGate: s.ageGate,
        freeGames: s.freeGames,
        freeGameClaims: s.freeGameClaims,
        purchases: s.purchases,
      }),
    },
  ),
);

/** Highest adventure level the player may start (1-based). */
export function unlockedLevel(stars: Record<number, number>): number {
  let level = 1;
  while ((stars[level] ?? 0) > 0) level++;
  return level;
}
