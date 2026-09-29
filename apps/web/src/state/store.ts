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

export type PopupName = 'settings' | 'profile' | 'tasks' | 'wallet' | 'fairness' | 'limits' | 'credits' | 'chest' | 'faucet';

export type TaskId = 'daub' | 'bingo' | 'modes' | 'spins';

export interface TaskDef {
  id: TaskId;
  label: string;
  goal: number;
  reward: number;
}

export const DAILY_TASKS: readonly TaskDef[] = [
  { id: 'daub', label: 'Daub 60 numbers', goal: 60, reward: 150 },
  { id: 'bingo', label: 'Shout 3 BINGOs', goal: 3, reward: 200 },
  { id: 'modes', label: 'Play 3 different games', goal: 3, reward: 250 },
  { id: 'spins', label: 'Play 10 house rounds', goal: 10, reward: 150 },
];

export const STARTING_COINS = 1000;
export const FAUCET_COINS = 500;
export const FAUCET_COOLDOWN_MS = 4 * 60 * 60 * 1000;
export const CHEST_KEYS = 3;
export const JACKPOT_SEED = 5000;
export const SEEKER_PERK_COINS = 2500;

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
  /** Daily net-loss limit in coins across wager modes (null = off). */
  dailyLossLimit: number | null;
  /** Cool-off: wager modes locked until this timestamp. */
  coolOffUntil: number;
}

interface FairnessState {
  serverSeed: string;
  commitment: string;
  clientSeed: string;
  nonce: number;
  previous: { serverSeed: string; clientSeed: string; lastNonce: number } | null;
}

export interface GameState {
  coins: number;
  keys: number;
  profile: { name: string; avatar: string };
  settings: Settings;
  limits: Limits;
  /** Stars per adventure level id. */
  stars: Record<number, number>;
  boosters: Record<BoosterId, number>;
  tasks: { day: string; progress: Record<TaskId, number>; claimed: TaskId[]; modesPlayed: ModeId[] };
  today: { day: string; wagered: number; won: number };
  stats: { rounds: number; bingos: number; biggestWin: number };
  faucetAt: number;
  /** Practice-room progressive jackpot (play money). */
  jackpot: { pool: number; lastWonDay: string };
  fairness: FairnessState;
  onboarded: boolean;
  /** Wallet linked via SIWS (display only in play-money mode). */
  linkedWallet: string | null;
  /** Seeker Genesis Token mints that already claimed the Seeker perk on this device. */
  seekerPerkMints: string[];

  // Session (not persisted)
  screen: Screen;
  popup: PopupName | null;
  sessionStart: number;
  /** A room code from an invite link, honoured once the player leaves the splash. */
  pendingJoin: string | null;

  go(screen: Screen): void;
  openPopup(popup: PopupName): void;
  closePopup(): void;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  setLimits(limits: Partial<Limits>): void;
  setProfile(profile: Partial<GameState['profile']>): void;
  addCoins(amount: number): void;
  /** Spend coins (e.g. a stake). Returns false when unaffordable or blocked by limits. */
  spend(amount: number, opts?: { wager?: boolean }): boolean;
  /** Record winnings from a wager round. */
  recordWin(amount: number): void;
  /** Give back a stake that was never played (a live round that started without these cards). */
  refund(amount: number): void;
  setPendingJoin(code: string | null): void;
  claimFaucet(): boolean;
  completeLevel(levelId: number, stars: number, coins: number): { newKey: boolean };
  openChest(): { coins: number; booster: BoosterId } | null;
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
  wagerBlockedReason(): string | null;
  contributeJackpot(amount: number): void;
  resetJackpot(): void;
  setLinkedWallet(address: string | null): void;
  claimSeekerPerk(mint: string): boolean;
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

export const useGame = create<GameState>()(
  persist(
    (set, get) => ({
      coins: STARTING_COINS,
      keys: 0,
      profile: { name: 'Beachcomber', avatar: '🦀' },
      settings: { sound: true, music: true, voice: true, haptics: true, reduceMotion: false },
      limits: { reminderMinutes: 60, dailyLossLimit: null, coolOffUntil: 0 },
      stars: {},
      boosters: { seagull: 1, crab: 2, wave: 1, sun: 1 },
      tasks: emptyTasks(),
      today: { day: localDay(), wagered: 0, won: 0 },
      stats: { rounds: 0, bingos: 0, biggestWin: 0 },
      faucetAt: 0,
      jackpot: { pool: JACKPOT_SEED, lastWonDay: localDay() },
      fairness: freshFairness(),
      onboarded: false,
      linkedWallet: null,
      seekerPerkMints: [],

      screen: { name: 'splash' },
      popup: null,
      sessionStart: Date.now(),
      pendingJoin: null,

      go: (screen) => set({ screen, popup: null }),
      openPopup: (popup) => set({ popup }),
      closePopup: () => set({ popup: null }),
      setSetting: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setLimits: (limits) => set((s) => ({ limits: { ...s.limits, ...limits } })),
      setProfile: (profile) => set((s) => ({ profile: { ...s.profile, ...profile } })),
      addCoins: (amount) => set((s) => ({ coins: s.coins + Math.max(0, Math.floor(amount)) })),

      spend: (amount, opts) => {
        const s = get();
        if (amount <= 0) return true;
        if (s.coins < amount) return false;
        if (opts?.wager && s.wagerBlockedReason()) return false;
        const today = s.today.day === localDay() ? s.today : { day: localDay(), wagered: 0, won: 0 };
        set({
          coins: s.coins - amount,
          today: opts?.wager ? { ...today, wagered: today.wagered + amount } : today,
        });
        return true;
      },

      recordWin: (amount) =>
        set((s) => {
          const today = s.today.day === localDay() ? s.today : { day: localDay(), wagered: 0, won: 0 };
          return {
            coins: s.coins + amount,
            today: { ...today, won: today.won + amount },
            stats: { ...s.stats, rounds: s.stats.rounds + 1, biggestWin: Math.max(s.stats.biggestWin, amount) },
          };
        }),

      refund: (amount) =>
        set((s) => {
          if (amount <= 0) return s;
          const today = s.today.day === localDay() ? s.today : { day: localDay(), wagered: 0, won: 0 };
          return { coins: s.coins + Math.floor(amount), today: { ...today, wagered: Math.max(0, today.wagered - amount) } };
        }),
      setPendingJoin: (pendingJoin) => set({ pendingJoin }),

      claimFaucet: () => {
        const s = get();
        if (Date.now() - s.faucetAt < FAUCET_COOLDOWN_MS) return false;
        set({ coins: s.coins + FAUCET_COINS, faucetAt: Date.now() });
        return true;
      },

      completeLevel: (levelId, stars, coins) => {
        const s = get();
        const before = s.stars[levelId] ?? 0;
        const newKey = stars === 3 && before < 3;
        set({
          stars: { ...s.stars, [levelId]: Math.max(before, stars) },
          coins: s.coins + coins,
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
        const coins = 400 + Math.floor(Math.random() * 5) * 100;
        set({
          keys: s.keys - CHEST_KEYS,
          coins: s.coins + coins,
          boosters: { ...s.boosters, [booster]: s.boosters[booster] + 1 },
        });
        return { coins, booster };
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
        set({ coins: s.coins + def.reward, tasks: { ...s.tasks, claimed: [...s.tasks.claimed, task] } });
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
              },
            },
          };
        }),

      contributeJackpot: (amount) => set((s) => ({ jackpot: { ...s.jackpot, pool: s.jackpot.pool + Math.max(0, amount) } })),
      resetJackpot: () => set({ jackpot: { pool: JACKPOT_SEED, lastWonDay: localDay() } }),
      setLinkedWallet: (linkedWallet) => set({ linkedWallet }),
      claimSeekerPerk: (mint) => {
        const s = get();
        if (s.seekerPerkMints.includes(mint)) return false;
        set({
          seekerPerkMints: [...s.seekerPerkMints, mint],
          coins: s.coins + SEEKER_PERK_COINS,
          boosters: { ...s.boosters, seagull: s.boosters.seagull + 2, crab: s.boosters.crab + 2, wave: s.boosters.wave + 2, sun: s.boosters.sun + 2 },
        });
        return true;
      },

      wagerBlockedReason: () => {
        const s = get();
        if (s.limits.coolOffUntil > Date.now()) {
          return `Cool-off active until ${new Date(s.limits.coolOffUntil).toLocaleString()}`;
        }
        const today = s.today.day === localDay() ? s.today : { wagered: 0, won: 0 };
        if (s.limits.dailyLossLimit !== null && today.wagered - today.won >= s.limits.dailyLossLimit) {
          return 'Daily loss limit reached — come back tomorrow.';
        }
        return null;
      },
    }),
    {
      name: 'beach-bingo',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        coins: s.coins,
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
        jackpot: s.jackpot,
        fairness: s.fairness,
        onboarded: s.onboarded,
        linkedWallet: s.linkedWallet,
        seekerPerkMints: s.seekerPerkMints,
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
