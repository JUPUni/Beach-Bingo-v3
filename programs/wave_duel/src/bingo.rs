//! A staked Wave Rush round, exactly as the engine builds it for a live room
//! (apps/web/src/rooms/live/protocol.ts `buildRoom`): cards are numbered in roster order (the
//! host's cards first, then each player's in join order), card `i` comes from the stream
//! `live:card:i`, the drum is `sample(1..=30, 30)` from `live:draw`, and the first ball that
//! completes any card ends the round. Every card full on that ball wins an equal share.
//!
//! `play_hall` is the general replay (2..=8 players, 1..=4 cards each); `play` is the 1v1 room
//! (one card each, host card 0, guest card 1) expressed through it, so both modes share one
//! implementation and one set of test vectors keeps them honest.
use crate::fair::{hex, sample, with_decimal, FairRng, HmacKey};

pub const BALLS: u8 = 30;
pub const CELLS: usize = 9;
/// A hall seats at most this many players, each holding at most `MAX_CARDS_PER_PLAYER` cards.
pub const MAX_PLAYERS: usize = 8;
pub const MAX_CARDS_PER_PLAYER: u8 = 4;

/// The 1v1 room's result.
pub struct Outcome {
    pub host_card: [u8; CELLS],
    pub guest_card: [u8; CELLS],
    pub drum: [u8; BALLS as usize],
    pub win_ball: u8,
    pub host_won: bool,
    pub guest_won: bool,
}

/// One card of a hall round: who holds it, its cells, and whether it was full on the winning ball.
pub struct HallCard {
    /// Index of the owner in the roster (0 = host).
    pub owner: u8,
    pub cells: [u8; CELLS],
    pub won: bool,
}

/// A hall round's result: every card in card order, the drum, and the ball that ended the round.
pub struct HallOutcome {
    pub cards: Vec<HallCard>,
    pub drum: [u8; BALLS as usize],
    /// Balls on the table when the first card(s) filled (30 if none did, which a 30-ball drum
    /// never allows: every number of every card is drawn by then).
    pub win_ball: u8,
    /// How many cards were full on `win_ball`: the prize is split evenly between them.
    pub winning_cards: u16,
}

impl HallOutcome {
    /// Indices (card order) of the cards that won.
    pub fn winners(&self) -> Vec<u16> {
        self.cards.iter().enumerate().filter(|(_, c)| c.won).map(|(i, _)| i as u16).collect()
    }

    /// Winning cards per player in roster order: the number of shares each player is paid.
    pub fn shares(&self, players: usize) -> Vec<u16> {
        let mut out = vec![0u16; players];
        for c in self.cards.iter().filter(|c| c.won) {
            out[c.owner as usize] += 1;
        }
        out
    }
}

/// A 30-ball card: three columns from 1–10, 11–20, 21–30, three sorted numbers each, row-major cells.
pub fn card(server_seed: &[u8; 32], client_seed: &str, index: u32) -> [u8; CELLS] {
    card_with(&HmacKey::new(server_seed), client_seed, index)
}

fn card_with(key: &HmacKey, client_seed: &str, index: u32) -> [u8; CELLS] {
    let domain = with_decimal("live:card:", index as u64);
    let mut rng = FairRng::with_key(key, client_seed, 0, &domain);
    let mut cells = [0u8; CELLS];
    for c in 0..3u8 {
        let band: Vec<u8> = (c * 10 + 1..=c * 10 + 10).collect();
        let mut picks = sample(&band, 3, &mut rng);
        picks.sort_unstable();
        for r in 0..3 {
            cells[r * 3 + c as usize] = picks[r];
        }
    }
    cells
}

pub fn drum(server_seed: &[u8; 32], client_seed: &str) -> [u8; BALLS as usize] {
    drum_with(&HmacKey::new(server_seed), client_seed)
}

fn drum_with(key: &HmacKey, client_seed: &str) -> [u8; BALLS as usize] {
    let mut rng = FairRng::with_key(key, client_seed, 0, "live:draw");
    let all: Vec<u8> = (1..=BALLS).collect();
    let order = sample(&all, BALLS as usize, &mut rng);
    let mut out = [0u8; BALLS as usize];
    out.copy_from_slice(&order);
    out
}

/// Replay a hall: `cards_per_player` in roster order (host first). Cards are generated in that
/// order and numbered from 0, as the engine's `buyCards` numbers them when `buildRoom` buys each
/// roster entry's cards in turn. The client seed is the escrow's entropy as lowercase hex.
pub fn play_hall(server_seed: &[u8; 32], entropy: &[u8; 32], cards_per_player: &[u8]) -> HallOutcome {
    let client_seed = hex(entropy);
    let key = HmacKey::new(server_seed);
    let total: usize = cards_per_player.iter().map(|&c| c as usize).sum();
    let mut cards = Vec::with_capacity(total);
    for (owner, &count) in cards_per_player.iter().enumerate() {
        for _ in 0..count {
            let index = cards.len() as u32;
            cards.push(HallCard { owner: owner as u8, cells: card_with(&key, &client_seed, index), won: false });
        }
    }
    let drum = drum_with(&key, &client_seed);
    // A card is full once its last number is drawn, i.e. at the drum position of the latest of its
    // nine cells; the round ends at the earliest such position over all cards, and every card
    // that reaches it there wins. This is the engine's ball-by-ball daub (`drawNext` /
    // `completedCards`) without walking thirty balls over every card.
    let mut position = [0u8; BALLS as usize + 1];
    for (n, ball) in drum.iter().enumerate() {
        position[*ball as usize] = (n + 1) as u8;
    }
    let full_at: Vec<u8> = cards.iter().map(|c| c.cells.iter().map(|&cell| position[cell as usize]).max().unwrap_or(BALLS)).collect();
    let win_ball = full_at.iter().copied().min().unwrap_or(BALLS);
    let mut winning_cards = 0u16;
    for (c, &at) in cards.iter_mut().zip(full_at.iter()) {
        if at == win_ball {
            c.won = true;
            winning_cards += 1;
        }
    }
    HallOutcome { cards, drum, win_ball, winning_cards }
}

/// The 1v1 room: one card each, the host's card 0 and the guest's card 1. Both full on the same
/// ball is a tie. This is `play_hall` with the roster `[1, 1]`, bit for bit.
pub fn play(server_seed: &[u8; 32], entropy: &[u8; 32]) -> Outcome {
    let hall = play_hall(server_seed, entropy, &[1, 1]);
    Outcome {
        host_card: hall.cards[0].cells,
        guest_card: hall.cards[1].cells,
        drum: hall.drum,
        win_ball: hall.win_ball,
        host_won: hall.cards[0].won,
        guest_won: hall.cards[1].won,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        server_seed: String,
        commitment: String,
        client_seed: String,
        host_card: Vec<u8>,
        guest_card: Vec<u8>,
        drum: Vec<u8>,
        win_ball: u8,
        winners: Vec<u8>,
    }

    /// apps/web/scripts/wave-hall-vectors.mjs: a hall the engine played, roster in join order.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HallVector {
        server_seed: String,
        commitment: String,
        client_seed: String,
        /// Cards per player in roster order (host first).
        roster: Vec<u8>,
        /// Every card's cells, in card order.
        cards: Vec<Vec<u8>>,
        drum: Vec<u8>,
        win_ball: u8,
        /// Card indices that were full on `win_ball`.
        winners: Vec<u16>,
        /// Winning cards per player: the shares each is paid.
        shares: Vec<u16>,
    }

    fn bytes32(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn matches_the_engine_on_every_vector() {
        let vectors: Vec<Vector> = serde_json::from_str(include_str!("../tests/vectors/rounds.json")).unwrap();
        assert!(vectors.len() >= 16);
        for v in &vectors {
            let seed = bytes32(&v.server_seed);
            let entropy = bytes32(&v.client_seed);
            assert_eq!(hex(&solana_sha256_hasher::hashv(&[&seed]).to_bytes()), v.commitment);
            let out = play(&seed, &entropy);
            assert_eq!(out.host_card.to_vec(), v.host_card, "host card");
            assert_eq!(out.guest_card.to_vec(), v.guest_card, "guest card");
            assert_eq!(out.drum.to_vec(), v.drum, "drum");
            assert_eq!(out.win_ball, v.win_ball, "win ball");
            let mut winners = Vec::new();
            if out.host_won {
                winners.push(0u8);
            }
            if out.guest_won {
                winners.push(1u8);
            }
            assert_eq!(winners, v.winners, "winners");
        }
    }

    #[test]
    fn matches_the_engine_on_every_hall_vector() {
        let vectors: Vec<HallVector> = serde_json::from_str(include_str!("../tests/vectors/halls.json")).unwrap();
        assert!(vectors.len() >= 16);
        // The set must exercise the extremes the program allows: a full 8 × 4 hall and a 2 × 1 duel.
        assert!(vectors.iter().any(|v| v.roster.len() == MAX_PLAYERS && v.roster.iter().all(|&c| c == MAX_CARDS_PER_PLAYER)));
        assert!(vectors.iter().any(|v| v.roster == [1, 1]));
        for v in &vectors {
            let seed = bytes32(&v.server_seed);
            let entropy = bytes32(&v.client_seed);
            assert_eq!(hex(&solana_sha256_hasher::hashv(&[&seed]).to_bytes()), v.commitment);
            assert!((2..=MAX_PLAYERS).contains(&v.roster.len()));
            assert!(v.roster.iter().all(|&c| (1..=MAX_CARDS_PER_PLAYER).contains(&c)));
            let out = play_hall(&seed, &entropy, &v.roster);
            assert_eq!(out.cards.len(), v.cards.len(), "card count");
            let mut owner = 0usize;
            let mut left = v.roster[0];
            for (i, c) in out.cards.iter().enumerate() {
                while left == 0 {
                    owner += 1;
                    left = v.roster[owner];
                }
                left -= 1;
                assert_eq!(c.owner as usize, owner, "owner of card {i}");
                assert_eq!(c.cells.to_vec(), v.cards[i], "card {i}");
            }
            assert_eq!(out.drum.to_vec(), v.drum, "drum");
            assert_eq!(out.win_ball, v.win_ball, "win ball");
            assert_eq!(out.winners(), v.winners, "winners");
            assert_eq!(out.winning_cards as usize, v.winners.len(), "winning cards");
            assert_eq!(out.shares(v.roster.len()), v.shares, "shares");
            assert_eq!(out.shares(v.roster.len()).iter().map(|&s| s as usize).sum::<usize>(), v.winners.len());
        }
    }

    #[test]
    fn the_duel_is_the_two_card_hall() {
        let vectors: Vec<Vector> = serde_json::from_str(include_str!("../tests/vectors/rounds.json")).unwrap();
        for v in &vectors {
            let seed = bytes32(&v.server_seed);
            let entropy = bytes32(&v.client_seed);
            let duel = play(&seed, &entropy);
            let hall = play_hall(&seed, &entropy, &[1, 1]);
            assert_eq!(hall.cards[0].cells, duel.host_card);
            assert_eq!(hall.cards[1].cells, duel.guest_card);
            assert_eq!(hall.drum, duel.drum);
            assert_eq!(hall.win_ball, duel.win_ball);
            assert_eq!(hall.cards[0].won, duel.host_won);
            assert_eq!(hall.cards[1].won, duel.guest_won);
            assert!(hall.winning_cards >= 1);
        }
    }

    #[test]
    fn every_round_has_a_winner_by_the_last_ball() {
        // Every card's nine numbers are among the thirty balls, so a card is full by ball 30 at
        // the latest; the settlement therefore never divides by zero.
        for k in 0..64u8 {
            let seed = [k; 32];
            let entropy = [k ^ 0x5a; 32];
            let out = play_hall(&seed, &entropy, &[4, 1, 2, 4, 3, 1, 1, 4]);
            assert!(out.winning_cards >= 1);
            assert!(out.win_ball >= 9 && out.win_ball <= 30);
            assert_eq!(out.cards.len(), 20);
        }
    }

    #[test]
    fn rejection_sampling_is_unbiased_at_the_edge() {
        let seed = [7u8; 32];
        let mut rng = FairRng::new(&seed, "abc", 0, "t");
        for _ in 0..1000 {
            let x = rng.int(3);
            assert!(x < 3);
        }
        assert_eq!(FairRng::new(&seed, "abc", 0, "t").int(1), 0);
    }
}
