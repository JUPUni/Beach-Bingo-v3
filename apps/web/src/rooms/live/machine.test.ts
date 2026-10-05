import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitSeed, rooms, type RoomPresetId } from '@beach-bingo/engine';
import { LiveRoomMachine, type ChainView, type LiveEvent, type Wallet } from './machine.ts';
import { buildRoom, START_LEAD_MS, type Connect, type LiveMessage, type NetHandlers } from './protocol.ts';

/** An in-memory network: every peer in a code sees every other, messages arrive after `latency`. */
class Hub {
  latency = 20;
  private n = 0;
  private readonly codes = new Map<string, Map<string, NetHandlers>>();

  connect: Connect = async (code, on) => {
    const members = this.codes.get(code) ?? new Map<string, NetHandlers>();
    this.codes.set(code, members);
    const id = `peer-${String(++this.n).padStart(2, '0')}`;
    for (const [other, handlers] of members) {
      setTimeout(() => {
        handlers.peerJoin(id);
        on.peerJoin(other);
      }, this.latency);
    }
    members.set(id, on);
    return {
      selfId: id,
      send: (msg, to) => this.deliver(members, id, msg, to),
      leave: () => {
        members.delete(id);
        for (const handlers of members.values()) setTimeout(() => handlers.peerLeave(id), this.latency);
      },
      relayCount: () => 1,
    };
  };

  /** A message that did not come from a machine (a tampered client). */
  inject(code: string, from: string, msg: unknown): void {
    this.deliver(this.codes.get(code)!, from, msg);
  }

  private deliver(members: Map<string, NetHandlers>, from: string, msg: unknown, to?: string): void {
    const wire = JSON.stringify(msg);
    const latency = this.latency;
    for (const [other, handlers] of members) {
      if (other === from || (to && other !== to)) continue;
      setTimeout(() => handlers.message(JSON.parse(wire), from), latency);
    }
  }
}

function wallet(coins = 1000): Wallet & { coins: number; won: number } {
  return {
    coins,
    won: 0,
    blocked: () => null,
    spend(amount) {
      if (this.coins < amount) return false;
      this.coins -= amount;
      return true;
    },
    refund(amount) {
      this.coins += amount;
    },
    win(amount) {
      this.coins += amount;
      this.won += amount;
    },
  };
}

const CODE = 'KRT7W';
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function machine(hub: Hub, opts: { host: boolean; preset?: RoomPresetId; name: string; events?: LiveEvent[] }) {
  const w = wallet();
  const m = new LiveRoomMachine({
    code: CODE,
    host: opts.host,
    preset: opts.preset,
    name: opts.name,
    wallet: w,
    connect: hub.connect,
    onEvent: (e) => opts.events?.push(e),
  });
  return { m, w };
}

async function lobby(hub: Hub, preset: RoomPresetId) {
  const a = machine(hub, { host: true, preset, name: 'Ana' });
  const b = machine(hub, { host: false, name: 'Bo' });
  await a.m.open();
  await b.m.open();
  await tick(100);
  return { a, b };
}

/** Advance one ball at a time until `done` holds. */
async function playUntil(m: LiveRoomMachine, done: () => boolean, maxBalls = 90) {
  const interval = m.config!.drawIntervalMs;
  for (let i = 0; i < maxBalls && !done(); i++) await tick(interval);
  expect(done()).toBe(true);
}

describe('a live room', () => {
  let hub: Hub;
  beforeEach(() => {
    vi.useFakeTimers();
    hub = new Hub();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays in the host's currency: a coin room charges and pays everyone in coins, an old room message means SAND", async () => {
    const seen: string[] = [];
    const ledger = (): Wallet => ({
      blocked: () => null,
      spend: (_amount, currency) => (seen.push(`spend:${currency}`), true),
      refund: (_amount, currency) => void seen.push(`refund:${currency}`),
      win: (_amount, currency) => void seen.push(`win:${currency}`),
    });
    const a = new LiveRoomMachine({ code: CODE, host: true, preset: 'waveRush', currency: 'coins', name: 'Ana', wallet: ledger(), connect: hub.connect });
    const b = new LiveRoomMachine({ code: CODE, host: false, name: 'Bo', wallet: ledger(), connect: hub.connect });
    await a.open();
    await b.open();
    await tick(100);
    expect(a.currency).toBe('coins');
    expect(b.currency).toBe('coins');
    a.buy(1);
    b.buy(1);
    await tick(100);
    expect(seen).toEqual(['spend:coins', 'spend:coins']);
    a.start();
    await tick(START_LEAD_MS + 100);
    await playUntil(a, () => a.status === 'finished' && b.status === 'finished', 40);
    expect(seen.filter((x) => x.startsWith('win'))).toEqual(['win:coins', 'win:coins']);
    // A room message without a currency (a build from before the two tables) reads as SAND.
    hub.inject(CODE, a.selfId, { t: 'room', preset: 'waveRush', round: 1, commitment: a.commitment, playing: false });
    await tick(100);
    expect(b.currency).toBe('sand');
    a.leave();
    b.leave();
  });

  it('plays a Wave Rush round that both clients settle identically', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    expect(b.m.status).toBe('lobby');
    expect(b.m.hostId).toBe(a.m.selfId);
    expect(b.m.config?.id).toBe('wave-rush');
    expect(b.m.commitment).toBe(a.m.commitment);
    expect(b.m.peers.get(a.m.selfId)?.name).toBe('Ana');
    expect(a.m.canStart).toBe(false);

    a.m.buy(2);
    b.m.buy(1);
    await tick(100);
    expect(a.w.coins).toBe(980);
    expect(b.w.coins).toBe(990);
    expect(a.m.peers.get(b.m.selfId)?.cards).toBe(1);
    expect(b.m.peers.get(a.m.selfId)?.cards).toBe(2);
    expect(b.m.poolPreview).toBe(Math.floor(30 * 0.88));
    expect(a.m.canStart).toBe(true);

    a.m.start();
    await tick(100);
    expect(a.m.status).toBe('countdown');
    expect(b.m.status).toBe('countdown');
    expect(b.m.room!.players.map((p) => p.id)).toEqual([a.m.selfId, b.m.selfId].sort());
    expect(b.m.room!.players.map((p) => p.name)).toEqual(['Ana', 'Bo']);
    expect(b.m.isParticipant).toBe(true);
    // Cards are consumed by the round: the lobby is ready for the next one.
    expect(a.m.myCards).toBe(0);
    expect(b.m.peers.get(a.m.selfId)?.cards).toBe(0);

    await tick(START_LEAD_MS);
    expect(a.m.status).toBe('drawing');
    await playUntil(a.m, () => a.m.status === 'finished' && b.m.status === 'finished', 40);

    expect(a.m.room!.drawn).toEqual(b.m.room!.drawn);
    expect(a.m.room!.wins).toEqual(b.m.room!.wins);
    expect(a.m.settlement!.payouts).toEqual(b.m.settlement!.payouts);
    expect(a.m.room!.wins).toHaveLength(1);
    expect(commitSeed(a.m.revealedSeed!)).toBe(a.m.commitment);
    expect(b.m.revealedSeed).toBe(a.m.revealedSeed);
    expect(b.m.rosterHash).toBe(a.m.rosterHash);

    const paid = Object.values(a.m.settlement!.payouts).reduce((s, x) => s + x, 0);
    expect(paid).toBeLessThanOrEqual(a.m.settlement!.pool);
    expect(a.w.coins).toBe(980 + a.m.myPayout);
    expect(b.w.coins).toBe(990 + b.m.myPayout);
    expect(a.m.myPayout + b.m.myPayout).toBe(a.m.settlement!.pool);

    // Anyone can rebuild the round from the record.
    const again = buildRoom(a.m.config!, a.m.commitment, a.m.revealedSeed!, a.m.roster!);
    expect(again.drum).toEqual(a.m.room!.drum);
  });

  it('starts the next round with a fresh commitment', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    a.m.buy(1);
    b.m.buy(1);
    await tick(100);
    a.m.start();
    await tick(START_LEAD_MS + 200);
    await playUntil(a.m, () => b.m.status === 'finished', 40);
    const first = a.m.commitment;

    a.m.again();
    await tick(100);
    expect(a.m.status).toBe('lobby');
    expect(a.m.round).toBe(2);
    expect(a.m.commitment).not.toBe(first);
    expect(b.m.status).toBe('finished');
    expect(b.m.nextRoundReady).toBe(true);
    expect(b.m.round).toBe(2);
    expect(b.m.commitment).toBe(a.m.commitment);
    b.m.again();
    expect(b.m.status).toBe('lobby');
    expect(b.m.room).toBeNull();
    b.m.buy(2);
    a.m.buy(1);
    await tick(100);
    expect(a.m.canStart).toBe(true);
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('countdown');
    expect(b.m.room!.players.find((p) => p.id === b.m.selfId)!.cards).toHaveLength(2);
  });

  it('refunds a player the host did not seat, who then watches the round', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    const c = machine(hub, { host: false, name: 'Cy' });
    await c.m.open();
    await tick(100);
    a.m.buy(1);
    c.m.buy(1);
    await tick(100);
    hub.latency = 5000; // Bo's purchase is still in flight when Ana starts
    b.m.buy(2);
    expect(b.w.coins).toBe(980);
    hub.latency = 20;
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('countdown');
    expect(b.m.isParticipant).toBe(false);
    expect(b.w.coins).toBe(1000);
    expect(b.m.myCards).toBe(0);
    expect(b.m.room!.players.map((p) => p.name).sort()).toEqual(['Ana', 'Cy']);
    await tick(START_LEAD_MS);
    await playUntil(a.m, () => b.m.status === 'finished' && c.m.status === 'finished', 40);
    expect(b.m.myPayout).toBe(0);
    expect(b.m.room!.drawn).toEqual(c.m.room!.drawn);
    expect(b.w.coins).toBe(1000);
  });

  it('lets a late joiner watch a round in progress', async () => {
    const { a, b } = await lobby(hub, 'pierHall');
    a.m.buy(1);
    b.m.buy(1);
    await tick(100);
    a.m.start();
    await tick(START_LEAD_MS + 2200 * 3);
    const c = machine(hub, { host: false, name: 'Cy' });
    await c.m.open();
    await tick(100);
    expect(c.m.status).toBe('drawing');
    expect(c.m.isParticipant).toBe(false);
    expect(c.m.room!.drawn).toEqual(a.m.room!.drawn);
  });

  it('settles a duel on the earliest valid shout and locks out a false one', async () => {
    const { a, b } = await lobby(hub, 'riptideDuel');
    a.m.buy(1);
    b.m.buy(1);
    await tick(100);
    expect(a.m.poolPreview).toBe(95);
    a.m.start();
    await tick(START_LEAD_MS + 100);
    expect(a.m.status).toBe('drawing');

    const complete = (m: LiveRoomMachine, id: string) => rooms.completedCards(m.room!, id).length > 0;
    await playUntil(a.m, () => complete(a.m, a.m.selfId) || complete(a.m, b.m.selfId));
    const winner = complete(a.m, a.m.selfId) ? a : b;
    const loser = winner === a ? b : a;
    const ball = a.m.room!.drawn.length;
    expect(complete(loser.m, loser.m.selfId)).toBe(false);

    loser.m.claim(); // nothing to claim: a false call
    expect(loser.m.lockedUntilBall).toBe(ball + 3);
    expect(loser.m.claims).toHaveLength(0);
    winner.m.claim();
    expect(winner.m.claims).toEqual([{ peerId: winner.m.selfId, card: 0, ball }]);
    await tick(100);
    expect(loser.m.claims).toEqual([{ peerId: winner.m.selfId, card: 0, ball }]);

    await tick(1800 * 2 + 200);
    expect(a.m.status).toBe('finished');
    expect(b.m.status).toBe('finished');
    expect(a.m.room!.wins).toEqual(b.m.room!.wins);
    expect(a.m.room!.wins[0]!.winners).toEqual([{ playerId: winner.m.selfId, card: 0 }]);
    expect(a.m.room!.wins[0]!.ballCount).toBe(ball);
    expect(winner.w.coins).toBe(950 + 95);
    expect(loser.w.coins).toBe(950);
  });

  it('shares a duel between two shouts on the same ball', async () => {
    const { a, b } = await lobby(hub, 'riptideDuel');
    a.m.buy(1);
    b.m.buy(1);
    await tick(100);
    a.m.start();
    await tick(START_LEAD_MS + 100);
    const complete = (m: LiveRoomMachine, id: string) => rooms.completedCards(m.room!, id).length > 0;
    await playUntil(a.m, () => complete(a.m, a.m.selfId) && complete(a.m, b.m.selfId));
    a.m.claim();
    b.m.claim();
    await tick(1800 * 2 + 300);
    expect(a.m.status).toBe('finished');
    expect(a.m.room!.wins[0]!.winners).toHaveLength(2);
    expect(a.m.room!.wins[0]!.prizeEach).toBe(47);
    expect(a.m.settlement!.payouts).toEqual(b.m.settlement!.payouts);
    expect(a.w.coins).toBe(997);
    expect(b.w.coins).toBe(997);
  });

  it('ignores claims that do not verify, and starts from anyone but the host', async () => {
    const { a, b } = await lobby(hub, 'riptideDuel');
    a.m.buy(1);
    b.m.buy(1);
    await tick(100);
    const bogusStart: LiveMessage = { t: 'start', round: 1, serverSeed: a.m.commitment, startAt: Date.now(), roster: [] };
    hub.inject(CODE, b.m.selfId, bogusStart);
    await tick(100);
    expect(a.m.status).toBe('lobby');
    a.m.start();
    await tick(START_LEAD_MS + 1800 * 3 + 100);
    expect(rooms.completedCards(b.m.room!, a.m.selfId)).toHaveLength(0);
    hub.inject(CODE, a.m.selfId, { t: 'claim', round: 1, card: 0, ball: 3 });
    hub.inject(CODE, a.m.selfId, { t: 'claim', round: 1, card: 0, ball: 40 }); // far ahead of the table
    await tick(100);
    expect(b.m.claims).toEqual([]);
  });

  it('refunds and ends when the host leaves the lobby', async () => {
    const { a, b } = await lobby(hub, 'sunsetHall');
    b.m.buy(1);
    expect(b.w.coins).toBe(975);
    a.m.leave();
    await tick(100);
    expect(b.m.status).toBe('error');
    expect(b.m.hostLeft).toBe(true);
    expect(b.w.coins).toBe(1000);
  });

  it('refunds cards bought for a round that never started when leaving', async () => {
    const { b } = await lobby(hub, 'sunsetHall');
    b.m.buy(3);
    expect(b.w.coins).toBe(925);
    b.m.leave();
    expect(b.w.coins).toBe(1000);
  });

  it('gives up on a code nobody answers', async () => {
    const b = machine(hub, { host: false, name: 'Bo' });
    await b.m.open();
    expect(b.m.status).toBe('connecting');
    await tick(26_000);
    expect(b.m.status).toBe('error');
    expect(b.m.error).toMatch(/No room KRT7W answered/);
  });

  it('plays a staked room from the escrow pair with the chain entropy, leaving coins alone', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    const stake = { kind: 'room' as const, lamports: '100000000', host: '2'.repeat(32), program: '3'.repeat(32), room: '4'.repeat(32) };
    a.m.setStake(stake, stake.host);
    await tick(100);
    expect(b.m.stake).toEqual(stake);
    expect(b.m.peers.get(a.m.selfId)?.wallet).toBe(stake.host);
    expect(b.m.peers.get(a.m.selfId)?.cards).toBe(1);
    b.m.buy(1);
    expect(b.m.myCards).toBe(0);
    expect(b.w.coins).toBe(1000);
    expect(a.m.canStart).toBe(false);

    const guestWallet = '5'.repeat(32);
    const entropy = 'ab'.repeat(32);
    const view = { kind: 'room' as const, state: 'ready' as const, guest: guestWallet, entropy, commitment: a.m.commitment, joinedSlot: 10n };
    b.m.seatTaken(guestWallet);
    b.m.setChain(view);
    await tick(100);
    expect(a.m.peers.get(b.m.selfId)?.wallet).toBe(guestWallet);
    expect(a.m.canStart).toBe(false); // the host has not read the chain yet
    a.m.setChain(view);
    expect(a.m.canStart).toBe(true);

    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('countdown');
    expect(b.m.room!.players.map((p) => p.id)).toEqual([a.m.selfId, b.m.selfId]);
    await tick(START_LEAD_MS);
    await playUntil(a.m, () => a.m.status === 'finished' && b.m.status === 'finished', 40);
    expect(a.m.room!.drawn).toEqual(b.m.room!.drawn);
    expect(a.m.iWon || b.m.iWon).toBe(true);
    expect(a.m.myPayout).toBe(0);
    expect(a.w.coins).toBe(1000);
    expect(b.w.coins).toBe(1000);
    // The engine, given the escrow's inputs, rebuilds the very same round the program will replay.
    const again = buildRoom(a.m.config!, a.m.commitment, a.m.revealedSeed!, a.m.roster!, entropy);
    expect(again.drum).toEqual(a.m.room!.drum);
    expect(again.players[0]!.cards[0]!.cells).toEqual(a.m.room!.players[0]!.cards[0]!.cells);
  });

  it('refuses a staked start whose entropy is not the one on chain', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    const stake = { kind: 'room' as const, lamports: '100000000', host: '2'.repeat(32), program: '3'.repeat(32), room: '4'.repeat(32) };
    a.m.setStake(stake, stake.host);
    await tick(100);
    const guestWallet = '5'.repeat(32);
    b.m.seatTaken(guestWallet);
    b.m.setChain({ kind: 'room', state: 'ready', guest: guestWallet, entropy: 'cd'.repeat(32), commitment: a.m.commitment, joinedSlot: 10n });
    await tick(100);
    a.m.setChain({ kind: 'room', state: 'ready', guest: guestWallet, entropy: 'ab'.repeat(32), commitment: a.m.commitment, joinedSlot: 10n });
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('error');
    expect(b.m.error).toMatch(/entropy/);
  });

  /* ---------- Staked halls: the roster is the chain's seats (wallets, join order), the client seed its entropy ---------- */
  const HOST_W = '2'.repeat(32);
  const BO_W = '5'.repeat(32);
  const CY_W = '6'.repeat(32);
  const GHOST_W = '7'.repeat(32);
  const ENTROPY = 'ab'.repeat(32);
  const hallStake = { kind: 'hall' as const, lamports: '10000000', stakePerCard: '10000000', maxPlayers: 4, host: HOST_W, program: '3'.repeat(32), room: '4'.repeat(32) };
  const hallView = (commitment: string, state: 'open' | 'locked', seats: { player: string; cards: number }[], entropy: string | null): ChainView => ({
    kind: 'hall',
    state,
    seats,
    entropy,
    commitment,
    lockedSlot: entropy ? 20n : 0n,
  });
  /** The `hallRoster` shape of solana/waveHall.ts: ids are the wallets, in seat order. */
  const seatsRoster = (seats: { player: string; cards: number }[]) => seats.map((s, i) => ({ id: s.player, name: i === 0 ? 'Host' : `Seat ${i + 1}`, cards: s.cards }));
  const replay = (m: LiveRoomMachine, seats: { player: string; cards: number }[]) => {
    const state = buildRoom(m.config!, m.commitment, m.revealedSeed!, seatsRoster(seats), ENTROPY);
    while (state.phase === 'drawing') rooms.drawNext(state);
    return state;
  };

  it('plays a staked hall of three (2/1/3 cards) from the chain seats with the locked entropy, coins untouched', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    const c = machine(hub, { host: false, name: 'Cy' });
    await c.m.open();
    await tick(100);
    a.m.setStake(hallStake, HOST_W, 2);
    await tick(100);
    expect(b.m.stake).toEqual(hallStake);
    expect(c.m.isHall).toBe(true);
    expect(b.m.peers.get(a.m.selfId)).toMatchObject({ wallet: HOST_W, cards: 2 });
    b.m.buy(1);
    expect(b.w.coins).toBe(1000);
    expect(b.m.myCards).toBe(0);

    // The host's seat is on chain; the guests' deposits follow, each announcing its wallet.
    const opened = hallView(a.m.commitment, 'open', [{ player: HOST_W, cards: 2 }], null);
    for (const x of [a, b, c]) x.m.setChain(opened);
    expect(b.m.seats.map((s) => [s.peer?.name ?? null, s.cards, s.host, s.me])).toEqual([['Ana', 2, true, false]]);
    b.m.seatTaken(BO_W, 1);
    c.m.seatTaken(CY_W, 3);
    await tick(100);
    const seats = [
      { player: HOST_W, cards: 2 },
      { player: BO_W, cards: 1 },
      { player: CY_W, cards: 3 },
    ];
    const selling = hallView(a.m.commitment, 'open', seats, null);
    for (const x of [a, b, c]) x.m.setChain(selling);
    expect(a.m.seats.map((s) => [s.peer?.name, s.cards])).toEqual([
      ['Ana', 2],
      ['Bo', 1],
      ['Cy', 3],
    ]);
    expect(b.m.seats[1]!.me).toBe(true);
    expect(a.m.canStart).toBe(false); // selling: not locked yet
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('lobby');

    // A guest locks; everyone reads the lock, the host last.
    const locked = hallView(a.m.commitment, 'locked', seats, ENTROPY);
    b.m.setChain(locked);
    c.m.setChain(locked);
    expect(a.m.canStart).toBe(false);
    a.m.setChain(locked);
    expect(a.m.canStart).toBe(true);
    a.m.start();
    await tick(100);
    for (const x of [a, b, c]) expect(x.m.status).toBe('countdown');
    expect(b.m.room!.players.map((p) => [p.id, p.name, p.cards.length])).toEqual([
      [HOST_W, 'Ana', 2],
      [BO_W, 'Bo', 1],
      [CY_W, 'Cy', 3],
    ]);
    expect(c.m.playerId).toBe(CY_W);
    expect(c.m.isParticipant).toBe(true);
    expect(c.m.peers.get(a.m.selfId)?.cards).toBe(0);

    await tick(START_LEAD_MS);
    await playUntil(a.m, () => [a, b, c].every((x) => x.m.status === 'finished'), 40);
    expect(b.m.room!.drawn).toEqual(a.m.room!.drawn);
    expect(c.m.room!.drawn).toEqual(a.m.room!.drawn);
    expect(c.m.room!.wins).toEqual(a.m.room!.wins);
    const winningCards = a.m.room!.wins[0]!.winners.length;
    expect(winningCards).toBeGreaterThan(0);
    expect(a.m.myWinningCards + b.m.myWinningCards + c.m.myWinningCards).toBe(winningCards);
    expect([a, b, c].filter((x) => x.m.iWon).length).toBeGreaterThan(0);
    for (const x of [a, b, c]) {
      expect(x.m.myPayout).toBe(0);
      expect(x.w.coins).toBe(1000);
    }
    // The engine, given the table's seats and entropy, rebuilds the very round the program will replay.
    const again = replay(a.m, seats);
    expect(again.drum).toEqual(a.m.room!.drum);
    expect(again.players.map((p) => p.cards.map((card) => card.cells))).toEqual(a.m.room!.players.map((p) => p.cards.map((card) => card.cells)));
    expect(again.wins).toEqual(a.m.room!.wins);
  });

  it('refuses a hall start whose roster is not the seats on chain, even when the lock is read after the start', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    const c = machine(hub, { host: false, name: 'Cy' });
    await c.m.open();
    await tick(100);
    a.m.setStake(hallStake, HOST_W, 2);
    await tick(100);
    b.m.seatTaken(BO_W, 1);
    c.m.seatTaken(CY_W, 3);
    await tick(100);
    const seats = [
      { player: HOST_W, cards: 2 },
      { player: BO_W, cards: 1 },
      { player: CY_W, cards: 3 },
    ];
    b.m.setChain(hallView(a.m.commitment, 'locked', seats, ENTROPY));
    // Cy's poll has not seen the lock yet.
    c.m.setChain(hallView(a.m.commitment, 'open', seats, null));
    // The host starts from a table with one card too many for Bo (a tampered host, or another hall).
    a.m.setChain(hallView(a.m.commitment, 'locked', [seats[0]!, { player: BO_W, cards: 2 }, seats[2]!], ENTROPY));
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('error');
    expect(b.m.error).toMatch(/seats on chain/);
    // Cy accepted the shape for now and checks again the moment the lock is read.
    expect(c.m.status).toBe('countdown');
    c.m.setChain(hallView(a.m.commitment, 'locked', seats, ENTROPY));
    expect(c.m.status).toBe('error');
    expect(c.m.error).toMatch(/seats on chain/);
  });

  it('seats a wallet no peer announced: its cards are on chain and it plays under its address', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    a.m.setStake(hallStake, HOST_W, 1);
    await tick(100);
    b.m.seatTaken(BO_W, 2);
    await tick(100);
    const seats = [
      { player: HOST_W, cards: 1 },
      { player: BO_W, cards: 2 },
      { player: GHOST_W, cards: 4 },
    ];
    const locked = hallView(a.m.commitment, 'locked', seats, ENTROPY);
    a.m.setChain(locked);
    b.m.setChain(locked);
    expect(a.m.seats[2]).toMatchObject({ wallet: GHOST_W, cards: 4, peer: null, me: false, host: false });
    a.m.start();
    await tick(100);
    expect(b.m.status).toBe('countdown');
    expect(b.m.room!.players.map((p) => [p.id, p.name, p.cards.length])).toEqual([
      [HOST_W, 'Ana', 1],
      [BO_W, 'Bo', 2],
      [GHOST_W, '7777…7777', 4],
    ]);
    await tick(START_LEAD_MS);
    await playUntil(a.m, () => a.m.status === 'finished' && b.m.status === 'finished', 40);
    const again = replay(b.m, seats);
    expect(again.drum).toEqual(b.m.room!.drum);
    expect(again.wins).toEqual(b.m.room!.wins);
    expect(again.players[2]!.cards.map((card) => card.cells)).toEqual(b.m.room!.players[2]!.cards.map((card) => card.cells));
  });

  it('drops the stake in a guest lobby when the host calls the table off', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    a.m.setStake(hallStake, HOST_W, 1);
    await tick(100);
    b.m.seatTaken(BO_W, 2);
    expect(b.m.myWallet).toBe(BO_W);
    a.m.clearStake();
    await tick(100);
    expect(a.m.stake).toBeNull();
    expect(b.m.stake).toBeNull();
    expect(b.m.myWallet).toBeNull();
    expect(b.m.myCards).toBe(0);
    expect(a.m.peers.get(b.m.selfId)).toMatchObject({ cards: 0, wallet: null });
    b.m.buy(1);
    expect(b.w.coins).toBe(990);
  });

  it('leaves if the host reveals a seed that does not match its commitment', async () => {
    const { a, b } = await lobby(hub, 'waveRush');
    b.m.buy(1);
    await tick(100);
    const forged: LiveMessage = {
      t: 'start',
      round: 1,
      serverSeed: 'ab'.repeat(32),
      startAt: Date.now() + START_LEAD_MS,
      roster: [
        { id: a.m.selfId, name: 'Ana', cards: 1 },
        { id: b.m.selfId, name: 'Bo', cards: 1 },
      ],
    };
    hub.inject(CODE, a.m.selfId, forged);
    await tick(100);
    expect(b.m.status).toBe('error');
    expect(b.m.error).toMatch(/commitment/);
    expect(b.w.coins).toBe(1000);
  });
});
