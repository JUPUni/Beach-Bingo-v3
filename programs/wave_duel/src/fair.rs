//! The engine's provably fair RNG (packages/engine/src/rng/fair.ts), bit for bit:
//!
//! block(counter) = HMAC-SHA256(serverSeed, JSON([clientSeed, nonce, domain, counter]))
//!
//! Each block yields eight big-endian u32 words; `int(n)` is rejection sampling with
//! `limit = 2^32 − (2^32 mod n)`; `sample` is a partial Fisher–Yates. Anything that differs here
//! by one bit would make the chain disagree with every player's own screen.
//!
//! The block message is written byte by byte rather than with `format!`: on SBF the formatting
//! machinery costs more compute than the hashing, and a 32-card hall builds about seventy such
//! messages in one instruction.
use solana_sha256_hasher::hashv;

/// The server seed as an HMAC-SHA256 key: the inner and outer pads, computed once per round
/// rather than once per block (a 32-card hall computes about seventy blocks).
pub struct HmacKey {
    ipad: [u8; 64],
    opad: [u8; 64],
}

impl HmacKey {
    pub fn new(server_seed: &[u8; 32]) -> Self {
        let mut ipad = [0x36u8; 64];
        let mut opad = [0x5cu8; 64];
        for i in 0..32 {
            ipad[i] ^= server_seed[i];
            opad[i] ^= server_seed[i];
        }
        Self { ipad, opad }
    }

    fn mac(&self, message: &[u8]) -> [u8; 32] {
        let inner = hashv(&[&self.ipad, message]);
        hashv(&[&self.opad, inner.as_ref()]).to_bytes()
    }
}

enum Key<'a> {
    Owned(HmacKey),
    Shared(&'a HmacKey),
}

pub struct FairRng<'a> {
    key: Key<'a>,
    client_seed: &'a str,
    nonce: u64,
    domain: &'a str,
    block: [u8; 32],
    offset: usize,
    counter: u64,
}

impl<'a> FairRng<'a> {
    pub fn new(server_seed: &'a [u8; 32], client_seed: &'a str, nonce: u64, domain: &'a str) -> Self {
        Self { key: Key::Owned(HmacKey::new(server_seed)), client_seed, nonce, domain, block: [0; 32], offset: 32, counter: 0 }
    }

    /// The same stream, with a key prepared once for many streams.
    pub fn with_key(key: &'a HmacKey, client_seed: &'a str, nonce: u64, domain: &'a str) -> Self {
        Self { key: Key::Shared(key), client_seed, nonce, domain, block: [0; 32], offset: 32, counter: 0 }
    }

    fn hmac(&self, message: &[u8]) -> [u8; 32] {
        match &self.key {
            Key::Owned(key) => key.mac(message),
            Key::Shared(key) => key.mac(message),
        }
    }

    /// `JSON.stringify([clientSeed, nonce, domain, counter])` for the strings we use (hex,
    /// "live:card:N", "live:draw"): no escaping is ever needed, so it is a plain concatenation.
    fn message(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(self.client_seed.len() + self.domain.len() + 48);
        m.extend_from_slice(b"[\"");
        m.extend_from_slice(self.client_seed.as_bytes());
        m.extend_from_slice(b"\",");
        push_decimal(&mut m, self.nonce);
        m.extend_from_slice(b",\"");
        m.extend_from_slice(self.domain.as_bytes());
        m.extend_from_slice(b"\",");
        push_decimal(&mut m, self.counter);
        m.push(b']');
        m
    }

    pub fn uint32(&mut self) -> u32 {
        if self.offset + 4 > 32 {
            self.block = self.hmac(&self.message());
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

/// `n` in decimal, as JavaScript prints an integer (no sign, no padding).
pub fn push_decimal(out: &mut Vec<u8>, mut n: u64) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    while n > 0 {
        at -= 1;
        digits[at] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.extend_from_slice(&digits[at..]);
}

/// `prefix` followed by `n` in decimal, e.g. the stream name `live:card:12`.
pub fn with_decimal(prefix: &str, n: u64) -> String {
    let mut out = prefix.as_bytes().to_vec();
    push_decimal(&mut out, n);
    // Only ASCII went in.
    String::from_utf8(out).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_is_what_json_stringify_writes() {
        let seed = [1u8; 32];
        let rng = FairRng::new(&seed, "ff26", 0, "live:card:0");
        assert_eq!(rng.message(), br#"["ff26",0,"live:card:0",0]"#.to_vec());
        let mut rng = FairRng::new(&seed, "ab", 7, "live:draw");
        rng.counter = 1234567890123;
        assert_eq!(rng.message(), br#"["ab",7,"live:draw",1234567890123]"#.to_vec());
    }

    #[test]
    fn decimals_match_the_standard_formatter() {
        for n in [0u64, 1, 9, 10, 11, 99, 100, 4_294_967_295, u64::MAX] {
            let mut out = Vec::new();
            push_decimal(&mut out, n);
            assert_eq!(String::from_utf8(out).unwrap(), n.to_string());
            assert_eq!(with_decimal("live:card:", n), format!("live:card:{}", n));
        }
    }
}
