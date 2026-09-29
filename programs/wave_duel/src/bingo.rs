//! A staked 1v1 Wave Rush round, exactly as the engine builds it for a live room
//! (apps/web/src/rooms/live/protocol.ts `buildRoom`): the host's card is card 0, the guest's
//! card 1, one card each, the drum is `sample(1..=30, 30)`, and the first ball that completes a
//! card ends the round. Both complete on the same ball: a tie.
use crate::fair::{hex, sample, FairRng};

pub const BALLS: u8 = 30;
pub const CELLS: usize = 9;
const FULL: u16 = 0x1FF;

pub struct Outcome {
    pub host_card: [u8; CELLS],
    pub guest_card: [u8; CELLS],
    pub drum: [u8; BALLS as usize],
    pub win_ball: u8,
    pub host_won: bool,
    pub guest_won: bool,
}

/// A 30-ball card: three columns from 1–10, 11–20, 21–30, three sorted numbers each, row-major cells.
pub fn card(server_seed: &[u8; 32], client_seed: &str, index: u32) -> [u8; CELLS] {
    let domain = format!("live:card:{}", index);
    let mut rng = FairRng::new(server_seed, client_seed, 0, &domain);
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
    let mut rng = FairRng::new(server_seed, client_seed, 0, "live:draw");
    let all: Vec<u8> = (1..=BALLS).collect();
    let order = sample(&all, BALLS as usize, &mut rng);
    let mut out = [0u8; BALLS as usize];
    out.copy_from_slice(&order);
    out
}

fn mark(cells: &[u8; CELLS], mask: &mut u16, ball: u8) {
    for (i, cell) in cells.iter().enumerate() {
        if *cell == ball {
            *mask |= 1 << i;
        }
    }
}

pub fn play(server_seed: &[u8; 32], entropy: &[u8; 32]) -> Outcome {
    let client_seed = hex(entropy);
    let host_card = card(server_seed, &client_seed, 0);
    let guest_card = card(server_seed, &client_seed, 1);
    let drum = drum(server_seed, &client_seed);
    let (mut host_mask, mut guest_mask) = (0u16, 0u16);
    let mut win_ball = BALLS;
    let (mut host_won, mut guest_won) = (false, false);
    for (n, ball) in drum.iter().enumerate() {
        mark(&host_card, &mut host_mask, *ball);
        mark(&guest_card, &mut guest_mask, *ball);
        if host_mask == FULL || guest_mask == FULL {
            win_ball = (n + 1) as u8;
            host_won = host_mask == FULL;
            guest_won = guest_mask == FULL;
            break;
        }
    }
    Outcome { host_card, guest_card, drum, win_ball, host_won, guest_won }
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
