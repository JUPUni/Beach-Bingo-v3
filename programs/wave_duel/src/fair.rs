//! The engine's provably fair RNG (packages/engine/src/rng/fair.ts), bit for bit:
//!
//! block(counter) = HMAC-SHA256(serverSeed, JSON([clientSeed, nonce, domain, counter]))
//!
//! Each block yields eight big-endian u32 words; `int(n)` is rejection sampling with
//! `limit = 2^32 − (2^32 mod n)`; `sample` is a partial Fisher–Yates. Anything that differs here
//! by one bit would make the chain disagree with every player's own screen.
use solana_sha256_hasher::hashv;

pub struct FairRng<'a> {
    key: &'a [u8; 32],
    client_seed: &'a str,
    nonce: u64,
    domain: &'a str,
    block: [u8; 32],
    offset: usize,
    counter: u64,
}

impl<'a> FairRng<'a> {
    pub fn new(server_seed: &'a [u8; 32], client_seed: &'a str, nonce: u64, domain: &'a str) -> Self {
        Self { key: server_seed, client_seed, nonce, domain, block: [0; 32], offset: 32, counter: 0 }
    }

    fn hmac(&self, message: &[u8]) -> [u8; 32] {
        let mut ipad = [0x36u8; 64];
        let mut opad = [0x5cu8; 64];
        for i in 0..32 {
            ipad[i] ^= self.key[i];
            opad[i] ^= self.key[i];
        }
        let inner = hashv(&[&ipad, message]);
        hashv(&[&opad, inner.as_ref()]).to_bytes()
    }

    pub fn uint32(&mut self) -> u32 {
        if self.offset + 4 > 32 {
            // JSON.stringify([clientSeed, nonce, domain, counter]) for the strings we use (hex,
            // "live:card:0", "live:draw"): no escaping is ever needed.
            let message = format!("[\"{}\",{},\"{}\",{}]", self.client_seed, self.nonce, self.domain, self.counter);
            self.block = self.hmac(message.as_bytes());
            self.counter += 1;
            self.offset = 0;
        }
        let b = &self.block[self.offset..self.offset + 4];
        self.offset += 4;
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }

    /// Uniform integer in `[0, n)`, unbiased (rejection sampling).
    pub fn int(&mut self, n: u32) -> u32 {
        if n == 1 {
            return 0;
        }
        let n64 = n as u64;
        let limit = (1u64 << 32) - ((1u64 << 32) % n64);
        loop {
            let x = self.uint32() as u64;
            if x < limit {
                return (x % n64) as u32;
            }
        }
    }
}

/// `k` distinct items in draw order (partial Fisher–Yates), as the engine's `sample`.
pub fn sample(items: &[u8], k: usize, rng: &mut FairRng) -> Vec<u8> {
    let mut pool = items.to_vec();
    for i in 0..k {
        let j = i + rng.int((pool.len() - i) as u32) as usize;
        pool.swap(i, j);
    }
    pool.truncate(k);
    pool
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}
