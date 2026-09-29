import {
  commitSeed,
  createServerSeed,
  rooms,
  verifyCommitment,
  type RoomConfig,
  type RoomPresetId,
  type RoomSettlement,
  type RoomState,
  type StageWin,
} from '@beach-bingo/engine';
import {
  ballTime,
  ballsCalledAt,
  buildRoom,
  claimValid,
  CLAIM_LEAD_BALLS,
  CLAIM_WINDOW_BALLS,
  HALL_CARDS,
  HALL_PLAYERS,
  maxCardsFor,
  parseMessage,
  resolveClaims,
  rosterHash,
  sortRoster,
  START_LEAD_MS,
  type Claim,
  type Connect,
  type LiveMessage,
  type Net,
  type RosterEntry,
  type StakeInfo,
} from './protocol.ts';

/**
 * One live room as seen from this browser: the lobby, the shared clock, the claims and the
 * settlement. Plain TypeScript with no React or DOM in it, so it runs the same under vitest with
 * a fake network (machine.test.ts) and in the game with trystero (net.ts).
 *
 * Every client applies the same rules to the same messages, so they agree on the outcome without
 * trusting each other: a card count is only ever a player's own, the host's seed is checked
 * against its commitment, and every claim is verified against the drum everyone can recompute.
 */
export type LiveStatus = 'connecting' | 'lobby' | 'countdown' | 'drawing' | 'finished' | 'error';

export interface Peer {
  id: string;
  name: string;
  /** Cards held for the next round to start. */
  cards: number;
  joinedAt: number;
  /** When they first held a card: duels seat the first two. */
  firstCardAt: number;
  /** A `me` message arrived, so the name is theirs. */
  announced: boolean;
  /** Their wallet, in a staked room. */
  wallet: string | null;
}

/** One seat of a hall as the chain holds it: a wallet and the cards it bought. */
export interface ChainSeat {
  player: string;
  cards: number;
}

/** What the escrow program's account says right now (read by the screen, not the machine). */
export type ChainView =
  /** A 1v1 room: the guest and the entropy once the guest joined. */
  | {
      kind: 'room';
      state: 'open' | 'ready' | 'closed';
      guest: string | null;
      /** The round's client seed, fixed when the guest joined (hex). */
      entropy: string | null;
      commitment: string;
      joinedSlot: bigint;
    }
  /** A hall: the seats in join order, the host first, and the entropy once a guest locked it. */
  | {
      kind: 'hall';
      state: 'open' | 'locked' | 'closed';
      seats: ChainSeat[];
      entropy: string | null;
      commitment: string;
      lockedSlot: bigint;
    };

/** A hall's seat as the lobby lists it: the chain's wallet and cards, and the peer who owns it when one announced that wallet. */
export interface SeatView {
  wallet: string;
  cards: number;
  peer: Peer | null;
  me: boolean;
  host: boolean;
}

export interface RoundRecord {
  preset: RoomPresetId;
  code: string;
  round: number;
  commitment: string;
  serverSeed: string;
  rosterHash: string;
  roster: RosterEntry[];
  summary: string;
  stake?: StakeInfo;
  entropy?: string;
}

export type LiveEvent =
  | { kind: 'ball'; ball: number }
  | { kind: 'stage'; win: StageWin; mine: number }
  | { kind: 'countdown' }
  | { kind: 'drawing' }
  | { kind: 'finished'; payout: number; record: RoundRecord }
  | { kind: 'peer'; name: string; joined: boolean }
  | { kind: 'claimed'; mine: boolean; name: string }
  | { kind: 'coin' }
  | { kind: 'toast'; text: string; tone: 'info' | 'win' | 'warn' };

/** The coin balance, as the store implements it. Cards are paid for when bought and refunded when a round starts without them. */
export interface Wallet {
  blocked(): string | null;
  spend(amount: number): boolean;
  refund(amount: number): void;
  win(amount: number): void;
}

export interface MachineOptions {
  code: string;
  host: boolean;
  /** Which hall; the host chooses, guests learn it from the host. */
  preset?: RoomPresetId;
  name: string;
  wallet: Wallet;
  connect: Connect;
  onEvent?: (event: LiveEvent) => void;
}

const TICK_MS = 100;
const JOIN_TIMEOUT_MS = 25_000;
const FEED_LENGTH = 6;
/** A seat whose wallet no peer announced is named by its address. */
const shortWallet = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

export class LiveRoomMachine {
  readonly code: string;
  readonly host: boolean;
  selfId = '';
  status: LiveStatus = 'connecting';
  error = '';
  preset: RoomPresetId | null = null;
  config: RoomConfig | null = null;
  hostId: string | null = null;
  hostLeft = false;
  round = 1;
  commitment = '';
  /** The host's seed once revealed by `start`. */
  revealedSeed: string | null = null;
  rosterHash: string | null = null;
  roster: RosterEntry[] | null = null;
  /** Everyone connected, this browser included. Participants of a running round who left are dropped too; the room state keeps their cards. */
  peers = new Map<string, Peer>();
  myCards = 0;
  room: RoomState | null = null;
  startAt = 0;
  claims: Claim[] = [];
  lockedUntilBall = 0;
  feed: string[] = [];
  settlement: RoomSettlement | null = null;
  myPayout = 0;
  /** Guest: the host opened the next round while we were still looking at the results. */
  nextRoundReady = false;
  /** Staked rooms: the escrow the host opened. Seats are deposits, not coins. */
  stake: StakeInfo | null = null;
  myWallet: string | null = null;
  chain: ChainView | null = null;
  /** Signature of the settlement transaction, once somebody sent it from this screen. */
  settleTx: string | null = null;
  relays = 0;
  /** Bumped on every change; `subscribe` for notifications. */
  version = 0;

  private readonly opts: MachineOptions;
  private net: Net | null = null;
  private serverSeed = '';
  private lastStart: Extract<LiveMessage, { t: 'start' }> | null = null;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private openedAt = 0;
  private readonly listeners = new Set<() => void>();

  constructor(opts: MachineOptions) {
    this.opts = opts;
    this.code = opts.code;
    this.host = opts.host;
    if (opts.host) {
      if (!opts.preset) throw new Error('a host needs a preset');
      this.preset = opts.preset;
      this.config = rooms.ROOM_PRESETS[opts.preset];
      this.newSeed();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------- Lifecycle ---------- */

  async open(): Promise<void> {
    this.openedAt = Date.now();
    let net: Net;
    try {
      net = await this.opts.connect(this.code, {
        peerJoin: (id) => this.onPeerJoin(id),
        peerLeave: (id) => this.onPeerLeave(id),
        message: (data, from) => this.onMessage(data, from),
      });
    } catch (e) {
      this.fail(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.closed) {
      net.leave();
      return;
    }
    this.net = net;
    this.selfId = net.selfId;
    this.peers.set(net.selfId, { id: net.selfId, name: this.opts.name, cards: 0, joinedAt: Date.now(), firstCardAt: 0, announced: true, wallet: null });
    if (this.host) {
      this.hostId = net.selfId;
      this.status = 'lobby';
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  /** Leave the room. Cards bought for a round that never started come back. */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.refundLobbyCards();
    this.net?.leave();
    this.net = null;
  }

  /* ---------- Derived views ---------- */

  get me(): Peer | undefined {
    return this.peers.get(this.selfId);
  }

  get isDuel(): boolean {
    return this.config?.autoDaub === false;
  }

  get staked(): boolean {
    return this.stake !== null;
  }

  get isHall(): boolean {
    return this.stake?.kind === 'hall';
  }

  /** My id in a round: the peer id, or my wallet in a hall, whose roster is the chain's seats. */
  get playerId(): string {
    return this.isHall ? (this.myWallet ?? '') : this.selfId;
  }

  /** Did one of my cards take a stage? (Staked rooms settle in SOL, not coins.) */
  get iWon(): boolean {
    return this.myWinningCards > 0;
  }

  /** How many of my cards were full on the winning ball (a hall pays each of them a share). */
  get myWinningCards(): number {
    const id = this.playerId;
    if (!id || !this.room) return 0;
    let n = 0;
    for (const w of this.room.wins) for (const x of w.winners) if (x.playerId === id) n++;
    return n;
  }

  /** A hall's seats as the chain holds them, each matched to the peer who announced its wallet. */
  get seats(): SeatView[] {
    if (this.chain?.kind !== 'hall') return [];
    return this.chain.seats.map((s, i) => ({ wallet: s.player, cards: s.cards, peer: this.peerByWallet(s.player), me: s.player === this.myWallet, host: i === 0 }));
  }

  get hostName(): string {
    const host = this.hostId ? this.peers.get(this.hostId) : undefined;
    return host?.name || 'the host';
  }

  /** Connected players, host first, then in order of arrival. */
  get players(): Peer[] {
    return [...this.peers.values()].sort((a, b) => Number(b.id === this.hostId) - Number(a.id === this.hostId) || a.joinedAt - b.joinedAt);
  }

  /** Am I seated in the running round (as opposed to watching it)? */
  get isParticipant(): boolean {
    const id = this.playerId;
    return !!id && (this.room?.players.some((p) => p.id === id) ?? false);
  }

  /** The pool the lobby's cards would make. */
  get poolPreview(): number {
    if (!this.config) return 0;
    let cards = 0;
    for (const p of this.peers.values()) cards += p.cards;
    return Math.floor(cards * this.config.cardPrice * this.config.payoutRate);
  }

  get minPlayers(): number {
    const rule = this.config?.startRule;
    return !rule ? 2 : rule.kind === 'sitAndGo' ? rule.players : rule.minPlayers;
  }

  get canStart(): boolean {
    if (!this.host || this.status !== 'lobby') return false;
    if (this.stake?.kind === 'hall') return this.chain?.kind === 'hall' && this.chain.state === 'locked' && !!this.chain.entropy && this.buildRoster().length >= HALL_PLAYERS.min;
    if (this.stake) return this.chain?.kind === 'room' && this.chain.state === 'ready' && !!this.chain.entropy && this.buildRoster().length === 2;
    return this.buildRoster().length >= this.minPlayers;
  }

  /* ---------- Actions ---------- */

  buy(count: number): void {
    const config = this.config;
    if (this.status !== 'lobby' || !config || count < 1) return;
    if (this.stake) return this.toast('This room is staked: your seat is your deposit', 'warn');
    const me = this.me;
    if (!me) return;
    const max = maxCardsFor(config);
    if (this.myCards + count > max) return this.toast(`${max} card${max > 1 ? 's' : ''} at most in this hall`, 'warn');
    if (this.isDuel) {
      let others = 0;
      for (const p of this.peers.values()) if (p.id !== this.selfId && p.cards > 0) others++;
      if (others >= 2) return this.toast('This duel already has two players — wait for the next one', 'warn');
    }
    const blocked = this.opts.wallet.blocked();
    if (blocked) return this.toast(blocked, 'warn');
    if (!this.opts.wallet.spend(config.cardPrice * count)) return this.toast('Not enough coins', 'warn');
    this.myCards += count;
    if (me.cards === 0) me.firstCardAt = Date.now();
    me.cards = this.myCards;
    this.broadcast(this.meMsg());
    this.event({ kind: 'coin' });
    this.emit();
  }

  /** Host: reveal the seed and start the countdown. */
  start(): void {
    if (!this.host || this.status !== 'lobby' || !this.config) return;
    const roster = this.buildRoster();
    if (this.stake) {
      if (!this.canStart) return this.toast(this.isHall ? 'The table is not locked yet: a guest locks it once two players are seated' : 'The escrow is not ready: both deposits must be on chain', 'warn');
    } else if (roster.length < this.minPlayers) {
      return this.toast(`Need ${this.minPlayers} players with cards`, 'warn');
    }
    const msg: LiveMessage = { t: 'start', round: this.round, serverSeed: this.serverSeed, startAt: Date.now() + START_LEAD_MS, roster };
    if (this.stake && this.chain?.entropy) msg.entropy = this.chain.entropy;
    this.broadcast(msg);
    this.applyStart(msg);
  }

  /* ---------- Staked rooms (the escrow lives on chain; the screen reads it) ---------- */

  /** Host: the escrow is open on chain with my deposit in it (`cards` of them in a hall). */
  setStake(stake: StakeInfo, wallet: string, cards = 1): void {
    if (!this.host || this.status !== 'lobby') return;
    const me = this.me;
    if (!me) return;
    this.stake = stake;
    this.takeSeat(me, wallet, cards);
    this.broadcast(this.roomMsg());
    this.broadcast(this.meMsg());
    this.emit();
  }

  /** Guest: my deposit is on chain, so my seat is taken (with `cards` cards in a hall). */
  seatTaken(wallet: string, cards = 1): void {
    const me = this.me;
    if (!me || !this.stake) return;
    this.takeSeat(me, wallet, cards);
    this.broadcast(this.meMsg());
    this.emit();
  }

  /**
   * The screen read the escrow account; every side keeps it to gate the start and check the
   * reveal. A hall's round is checked again against every locked view that arrives, so a
   * screen whose poll lagged behind the host's start still refuses a round that is not the table's.
   */
  setChain(view: ChainView | null): void {
    this.chain = view;
    if (view && this.stake && view.commitment !== this.commitment && (this.status === 'lobby' || this.status === 'connecting')) {
      this.fail('The escrow on chain was opened with a different commitment than this room. Leaving.');
      return;
    }
    if (view && this.lastStart && (this.status === 'countdown' || this.status === 'drawing')) {
      const bad = this.hallStartMismatch(this.lastStart, view);
      if (bad) return this.fail(bad);
    }
    this.emit();
  }

  /** Host: the escrow was cancelled on chain before anyone joined. */
  clearStake(): void {
    if (!this.host || !this.stake) return;
    this.stake = null;
    this.chain = null;
    this.myWallet = null;
    this.myCards = 0;
    const me = this.me;
    if (me) {
      me.cards = 0;
      me.wallet = null;
    }
    this.broadcast(this.roomMsg());
    this.broadcast(this.meMsg());
    this.emit();
  }

  /** The settlement transaction went through (from either screen). */
  settled(signature: string): void {
    this.settleTx = signature;
    this.emit();
  }

  /** Duel: shout BINGO on a completed card. A false shout locks this player out for a few balls. */
  claim(): void {
    const room = this.room;
    if (!room || this.status !== 'drawing' || room.config.autoDaub || room.phase !== 'drawing') return;
    if (!this.isParticipant) return;
    if (room.drawn.length < this.lockedUntilBall) return this.toast('Locked out — wait a few balls', 'warn');
    const mine = rooms.completedCards(room, this.selfId);
    if (!mine.length) {
      this.lockedUntilBall = room.drawn.length + room.config.falseClaimPenaltyBalls;
      this.toast(`False call! Locked for ${room.config.falseClaimPenaltyBalls} balls`, 'warn');
      this.emit();
      return;
    }
    const claim: Claim = { peerId: this.selfId, card: mine[0]!.card, ball: room.drawn.length };
    if (this.claims.some((c) => c.peerId === claim.peerId && c.card === claim.card)) return;
    this.claims.push(claim);
    this.broadcast({ t: 'claim', round: this.round, card: claim.card, ball: claim.ball });
    this.event({ kind: 'claimed', mine: true, name: this.me?.name ?? 'You' });
    this.emit();
  }

  /** Back to the lobby for the next round (the host opens it with a fresh commitment). */
  again(): void {
    if (this.status !== 'finished') return;
    if (this.host) {
      this.newSeed();
      this.round += 1;
      this.playing = false;
      this.lastStart = null;
      this.resetRound();
      this.status = 'lobby';
      this.broadcast(this.roomMsg());
    } else {
      if (this.hostLeft) {
        this.fail('The host left the room. Open a new one to keep playing.');
        return;
      }
      this.resetRound();
      this.status = 'lobby';
    }
    this.emit();
  }

  /* ---------- Network events ---------- */

  private onPeerJoin(id: string): void {
    if (this.closed || this.status === 'error') return;
    if (!this.peers.has(id)) this.peers.set(id, { id, name: '', cards: 0, joinedAt: Date.now(), firstCardAt: 0, announced: false, wallet: null });
    this.send(this.meMsg(), id);
    if (this.host) {
      this.send(this.roomMsg(), id);
      // A round in progress: let the newcomer watch it from the same state.
      if (this.playing && this.lastStart) this.send(this.lastStart, id);
    }
    this.emit();
  }

  private onPeerLeave(id: string): void {
    if (this.closed || this.status === 'error') return;
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.announced) this.event({ kind: 'peer', name: peer.name, joined: false });
    if (id === this.hostId && !this.host) {
      this.hostLeft = true;
      if (this.status === 'lobby' || this.status === 'connecting') {
        this.refundLobbyCards();
        this.fail('The host left the room.');
        return;
      }
      // Mid-round the balls are already fixed: play on, the results say who left.
    }
    this.emit();
  }

  private onMessage(raw: unknown, from: string): void {
    if (this.closed || this.status === 'error') return;
    const msg = parseMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'me': {
        let peer = this.peers.get(from);
        if (!peer) {
          peer = { id: from, name: '', cards: 0, joinedAt: Date.now(), firstCardAt: 0, announced: false, wallet: null };
          this.peers.set(from, peer);
        }
        const first = !peer.announced;
        peer.announced = true;
        peer.name = msg.name;
        // A `me` without a wallet is a peer without a seat (never had one, or the escrow was called off).
        peer.wallet = msg.wallet ?? null;
        const cards = Math.min(msg.cards, this.config?.maxCardsPerPlayer ?? 6);
        if (cards > 0 && peer.cards === 0) peer.firstCardAt = Date.now();
        if (cards === 0) peer.firstCardAt = 0;
        peer.cards = cards;
        if (first) this.event({ kind: 'peer', name: peer.name, joined: true });
        this.emit();
        return;
      }
      case 'room': {
        // The first peer to answer a code is its host; a second "host" is a code collision.
        if (this.host || (this.hostId && from !== this.hostId)) return;
        const fresh = !this.hostId;
        this.hostId = from;
        this.preset = msg.preset;
        this.config = rooms.ROOM_PRESETS[msg.preset];
        if (fresh || msg.round !== this.round || msg.commitment !== this.commitment) {
          this.round = msg.round;
          this.commitment = msg.commitment;
          if (this.status === 'finished') this.nextRoundReady = true;
        }
        this.playing = msg.playing;
        if (msg.stake) this.stake = msg.stake;
        // The host called the escrow off while we were in the lobby: our seat, if we had one,
        // was refunded on chain with it. (At the results the panel keeps the old stake to settle.)
        else if (this.stake && (this.status === 'lobby' || this.status === 'connecting')) this.dropStake();
        if (this.status === 'connecting') this.status = 'lobby';
        this.emit();
        return;
      }
      case 'start': {
        if (this.host || from !== this.hostId || !this.config || msg.round !== this.round) return;
        if (this.status === 'countdown' || this.status === 'drawing') return;
        if (!verifyCommitment(msg.serverSeed, this.commitment)) {
          this.refundLobbyCards();
          this.fail("The host's seed does not match its commitment. Leaving the room.");
          return;
        }
        this.applyStart(msg);
        return;
      }
      case 'claim': {
        const room = this.room;
        if (!room || msg.round !== this.round || room.config.autoDaub || room.phase !== 'drawing') return;
        if (this.status !== 'countdown' && this.status !== 'drawing') return;
        if (msg.ball > room.drawn.length + CLAIM_LEAD_BALLS) return;
        if (this.claims.some((c) => c.peerId === from && c.card === msg.card)) return;
        if (!claimValid(room, from, msg.card, msg.ball)) return;
        this.claims.push({ peerId: from, card: msg.card, ball: msg.ball });
        const name = room.players.find((p) => p.id === from)?.name ?? 'Someone';
        this.pushFeed(`📣 ${name} shouts BINGO!`);
        this.event({ kind: 'claimed', mine: false, name });
        this.emit();
        return;
      }
    }
  }

  /* ---------- The round ---------- */

  private applyStart(msg: Extract<LiveMessage, { t: 'start' }>): void {
    const config = this.config!;
    if (this.stake?.kind === 'hall') {
      // A staked hall's round is exactly the table on chain: its seats, in order, with the entropy it locked with.
      if (!msg.entropy) return this.fail('The host started a staked round without the table entropy. Leaving.');
      const bad = this.hallStartMismatch(msg, this.chain);
      if (bad) return this.fail(bad);
    } else if (this.stake) {
      // A staked round is exactly the escrow's: host's card first, one card each, the escrow's entropy.
      if (!msg.entropy) return this.fail('The host started a staked round without the escrow entropy. Leaving.');
      if (this.chain?.entropy && this.chain.entropy !== msg.entropy) return this.fail('The host started with an entropy that is not the one on chain. Leaving.');
      if (msg.roster.length !== 2 || msg.roster[0]!.id !== this.hostId || msg.roster.some((e) => e.cards !== 1)) {
        return this.fail('The host started a staked round with a roster that is not the escrow pair. Leaving.');
      }
    }
    let room: RoomState;
    try {
      room = this.stake ? buildRoom(config, this.commitment, msg.serverSeed, msg.roster, msg.entropy) : buildRoom(config, this.commitment, msg.serverSeed, msg.roster);
    } catch (e) {
      this.refundLobbyCards();
      this.fail(`The host sent a round this hall cannot seat (${e instanceof Error ? e.message : String(e)}).`);
      return;
    }
    this.lastStart = msg;
    this.playing = true;
    this.room = room;
    this.roster = msg.roster;
    this.revealedSeed = msg.serverSeed;
    this.rosterHash = rosterHash(msg.roster);
    // The cards I bought are consumed by this round; whatever the host did not seat comes back.
    const seated = msg.roster.find((e) => e.id === this.playerId)?.cards ?? 0;
    if (!this.stake && this.myCards > seated) {
      this.opts.wallet.refund((this.myCards - seated) * config.cardPrice);
      if (seated === 0) this.toast('The round started without your cards — coins refunded. Watch this one.', 'warn');
    }
    this.myCards = 0;
    for (const e of msg.roster) {
      // A hall's roster names wallets; the peer holding one is the one who announced it.
      const p = this.isHall ? this.peerByWallet(e.id) : this.peers.get(e.id);
      if (p) {
        p.cards = 0;
        p.firstCardAt = 0;
      }
    }
    // Trust the host's clock within reason: a clock far ahead would stall the balls. A start in
    // the past is a round already under way (a late joiner watching): catch up on its balls.
    const now = Date.now();
    this.startAt = Math.min(msg.startAt, now + START_LEAD_MS + 1000);
    this.claims = [];
    this.lockedUntilBall = 0;
    this.feed = [];
    this.settlement = null;
    this.myPayout = 0;
    this.nextRoundReady = false;
    this.status = 'countdown';
    this.event({ kind: 'countdown' });
    this.emit();
  }

  private tick(): void {
    if (this.closed) return;
    let dirty = false;
    const relays = this.net?.relayCount() ?? 0;
    if (relays !== this.relays) {
      this.relays = relays;
      dirty = true;
    }
    const now = Date.now();
    if (this.status === 'connecting' && now - this.openedAt > JOIN_TIMEOUT_MS) {
      this.fail(`No room ${this.code} answered. Check the code and that the host still has the room open.`);
      return;
    }
    if (this.status === 'countdown' && now >= this.startAt) {
      this.status = 'drawing';
      this.event({ kind: 'drawing' });
      dirty = true;
    }
    if (this.status === 'drawing' && this.room) dirty = this.advance(now) || dirty;
    if (dirty) this.emit();
  }

  /** Call every ball that is due and settle every claim window that has closed, in the order every client shares. */
  private advance(now: number): boolean {
    const room = this.room!;
    const interval = room.config.drawIntervalMs;
    let changed = false;
    const due = ballsCalledAt(now, this.startAt, interval, room.drum.length);
    for (let guard = 0; guard < 200 && room.phase === 'drawing'; guard++) {
      const first = this.claims.length ? Math.min(...this.claims.map((c) => c.ball)) : null;
      if (first !== null && room.drawn.length >= Math.min(first + 1, room.drum.length) && now >= ballTime(first + CLAIM_WINDOW_BALLS, this.startAt, interval)) {
        this.settleClaims();
        changed = true;
        continue;
      }
      if (room.drawn.length < due) {
        const ev = rooms.drawNext(room);
        if (ev.ball) this.event({ kind: 'ball', ball: ev.ball });
        this.announce(ev.stageWins);
        changed = true;
        continue;
      }
      // A duel nobody claimed: the drum runs dry one interval after its last ball.
      if (room.drawn.length >= room.drum.length && !this.claims.length && now >= ballTime(room.drum.length + 1, this.startAt, interval)) {
        rooms.drawNext(room);
        changed = true;
      }
      break;
    }
    if (room.phase === 'finished' && this.status === 'drawing') {
      this.finish();
      changed = true;
    }
    return changed;
  }

  private settleClaims(): void {
    const room = this.room!;
    const winners = resolveClaims(this.claims);
    this.claims = [];
    room.pendingClaims = winners.map((w) => ({ playerId: w.peerId, card: w.card }));
    const win = rooms.closeClaims(room);
    if (win) {
      win.ballCount = winners[0]!.ball;
      this.announce([win]);
    }
  }

  private announce(wins: StageWin[]): void {
    const room = this.room!;
    for (const win of wins) {
      const names = win.winners.map((w) => room.players.find((p) => p.id === w.playerId)?.name ?? 'Someone');
      const label = room.config.stages[win.stage]?.pattern.name ?? 'Stage';
      this.pushFeed(`🏆 ${label}: ${names.join(', ')} (+${win.prizeEach} each)`);
      this.event({ kind: 'stage', win, mine: win.winners.filter((w) => w.playerId === this.selfId).length });
    }
  }

  private finish(): void {
    const room = this.room!;
    const settlement = rooms.settleRoom(room);
    this.settlement = settlement;
    const me = this.playerId ? room.players.find((p) => p.id === this.playerId) : undefined;
    const payout = settlement.payouts[this.playerId] ?? 0;
    // Prize money nobody won (an unclaimed duel, rounding) goes back to the players, by cards.
    const refund = me && settlement.unawarded > 0 && room.cardsSold > 0 ? Math.floor((settlement.unawarded * me.cards.length) / room.cardsSold) : 0;
    // Staked rooms settle on chain: the coins ledger is not touched.
    this.myPayout = this.stake ? 0 : payout + refund;
    if (me && !this.stake) {
      this.opts.wallet.win(payout);
      if (refund > 0) this.opts.wallet.refund(refund);
    }
    this.playing = false;
    this.status = 'finished';
    this.event({
      kind: 'finished',
      payout: this.myPayout,
      record: {
        preset: this.preset!,
        code: this.code,
        round: this.round,
        commitment: room.commitment,
        serverSeed: this.revealedSeed!,
        rosterHash: this.rosterHash!,
        roster: this.roster!,
        summary: this.stake
          ? me
            ? this.isHall
              ? `${this.myWinningCards} of ${me.cards.length} cards won at the staked table`
              : this.iWon
                ? 'won the staked round'
                : 'lost the staked round'
            : 'watched a staked round'
          : me
            ? `won ${payout} of pool ${settlement.pool}`
            : 'watched',
        ...(this.stake ? { stake: this.stake, entropy: this.chain?.entropy ?? undefined } : {}),
      },
    });
  }

  /* ---------- Helpers ---------- */

  private buildRoster(): RosterEntry[] {
    const config = this.config;
    if (!config) return [];
    if (this.stake?.kind === 'hall') {
      // The table as the chain holds it: seats in join order, ids are the wallets, so that the
      // engine numbers the cards as the program does (hallRoster in solana/waveHall.ts).
      if (this.chain?.kind !== 'hall') return [];
      return this.chain.seats.map((s, i) => ({ id: s.player, name: this.peerByWallet(s.player)?.name || (i === 0 ? 'Host' : shortWallet(s.player)), cards: s.cards }));
    }
    if (this.stake) {
      // The escrow pair, host first: the program builds card 0 for the host and card 1 for the guest.
      const host = this.hostId ? this.peers.get(this.hostId) : undefined;
      const guestWallet = this.chain?.kind === 'room' ? this.chain.guest : null;
      const guest = guestWallet ? [...this.peers.values()].find((p) => p.wallet === guestWallet && p.id !== this.hostId) : undefined;
      if (!host || !guest || host.cards < 1 || guest.cards < 1) return [];
      return [
        { id: host.id, name: host.name || 'Host', cards: 1 },
        { id: guest.id, name: guest.name || 'Guest', cards: 1 },
      ];
    }
    let entries = [...this.peers.values()].filter((p) => p.cards > 0);
    if (config.startRule.kind === 'sitAndGo') {
      entries = entries.sort((a, b) => a.firstCardAt - b.firstCardAt).slice(0, config.startRule.players);
    }
    return sortRoster(
      entries.map((p) => ({ id: p.id, name: p.name || 'Player', cards: p.cards })),
      config,
    );
  }

  /**
   * Why a hall's `start` is not the table on chain, or null when it is. Until this screen has
   * read the table as locked only the shape is checked (the host's seat first, a hall's size and
   * card counts); `setChain` asks again with every locked view.
   */
  private hallStartMismatch(msg: Extract<LiveMessage, { t: 'start' }>, view: ChainView | null): string | null {
    const stake = this.stake;
    if (stake?.kind !== 'hall') return null;
    const roster = msg.roster;
    if (roster[0]?.id !== stake.host) return 'The host started a staked round whose first seat is not the host. Leaving.';
    if (roster.length < HALL_PLAYERS.min || roster.length > stake.maxPlayers || roster.some((e) => e.cards < HALL_CARDS.min || e.cards > HALL_CARDS.max)) {
      return 'The host started a staked round that is not a table of this shape. Leaving.';
    }
    if (view?.kind !== 'hall' || view.state !== 'locked') return null;
    if (view.entropy !== msg.entropy) return 'The host started with an entropy that is not the one on chain. Leaving.';
    if (roster.length !== view.seats.length || roster.some((e, i) => e.id !== view.seats[i]!.player || e.cards !== view.seats[i]!.cards)) {
      return 'The host started a staked round with a roster that is not the seats on chain. Leaving.';
    }
    return null;
  }

  private peerByWallet(wallet: string): Peer | null {
    for (const p of this.peers.values()) if (p.wallet === wallet) return p;
    return null;
  }

  private takeSeat(me: Peer, wallet: string, cards: number): void {
    this.myWallet = wallet;
    me.wallet = wallet;
    me.cards = cards;
    me.firstCardAt = Date.now();
    this.myCards = cards;
  }

  /** Guest: the host called the escrow off, so there is no stake in this lobby any more. */
  private dropStake(): void {
    const seated = this.myWallet !== null;
    this.stake = null;
    this.chain = null;
    this.myWallet = null;
    this.myCards = 0;
    const me = this.me;
    if (me) {
      me.cards = 0;
      me.firstCardAt = 0;
      me.wallet = null;
    }
    if (seated) {
      this.broadcast(this.meMsg());
      this.toast('The host called the table off; your stake went back to your wallet');
    }
  }

  private newSeed(): void {
    this.serverSeed = createServerSeed();
    this.commitment = commitSeed(this.serverSeed);
  }

  private resetRound(): void {
    // One escrow, one round: the next round starts unstaked until the host opens a new escrow.
    this.stake = null;
    this.chain = null;
    this.settleTx = null;
    this.myWallet = null;
    for (const p of this.peers.values()) p.wallet = null;
    this.room = null;
    this.roster = null;
    this.revealedSeed = null;
    this.rosterHash = null;
    this.settlement = null;
    this.myPayout = 0;
    this.claims = [];
    this.lockedUntilBall = 0;
    this.feed = [];
    this.nextRoundReady = false;
  }

  private refundLobbyCards(): void {
    if (this.stake) return; // a deposit is not coins; it is cancelled or settled on chain
    if (this.myCards > 0 && this.config) {
      this.opts.wallet.refund(this.myCards * this.config.cardPrice);
      this.myCards = 0;
      const me = this.me;
      if (me) me.cards = 0;
    }
  }

  private fail(message: string): void {
    this.status = 'error';
    this.error = message;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.emit();
  }

  private meMsg(): LiveMessage {
    return { t: 'me', name: this.opts.name, cards: this.myCards, ...(this.myWallet ? { wallet: this.myWallet } : {}) };
  }

  private roomMsg(): LiveMessage {
    return { t: 'room', preset: this.preset!, round: this.round, commitment: this.commitment, playing: this.playing, ...(this.stake ? { stake: this.stake } : {}) };
  }

  private send(msg: LiveMessage, to: string): void {
    this.net?.send(msg, to);
  }

  private broadcast(msg: LiveMessage): void {
    this.net?.send(msg);
  }

  private pushFeed(line: string): void {
    this.feed = [line, ...this.feed].slice(0, FEED_LENGTH);
  }

  private toast(text: string, tone: 'info' | 'win' | 'warn' = 'info'): void {
    this.event({ kind: 'toast', text, tone });
  }

  private event(event: LiveEvent): void {
    this.opts.onEvent?.(event);
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
