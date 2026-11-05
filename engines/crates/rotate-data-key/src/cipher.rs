//! `contexts/identity/infrastructure/secret-cipher.ts`: AES-256-GCM sealing (ADR 0004),
//! `v1.<base64url(nonce | ciphertext | tag)>`.

use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};

const VERSION: &str = "v1";
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// `Buffer.from(value, 'base64url')`: Node reads the low byte of each UTF-16 code unit (so `Ł`,
/// U+0141, counts as `A` and a high surrogate's `0x3D` as `=`), accepts both alphabets, skips
/// other bytes, stops at the first `=` and drops a trailing lone sextet.
#[must_use]
pub fn decode_base64_lenient(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for unit in value.encode_utf16() {
        let byte = u8::try_from(unit & 0xFF).unwrap_or(0);
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = ((buffer << 6) | u32::from(sextet)) & 0x00FF_FFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xFF).unwrap_or(0));
        }
    }
    out
}

/// `buffer.toString('base64url')`: no padding.
#[must_use]
pub fn encode_base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let symbol =
        |index: u32| char::from(ALPHABET.get(index as usize & 63).copied().unwrap_or(b'A'));
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b =
            [chunk.first(), chunk.get(1), chunk.get(2)].map(|b| u32::from(b.copied().unwrap_or(0)));
        let n = (b[0] << 16) | (b[1] << 8) | b[2];
        out.push(symbol(n >> 18));
        out.push(symbol(n >> 12));
        if chunk.len() > 1 {
            out.push(symbol(n >> 6));
        }
        if chunk.len() > 2 {
            out.push(symbol(n));
        }
    }
    out
}

/// Seals and opens with one 32-byte key.
pub struct Cipher {
    key: LessSafeKey,
    rng: SystemRandom,
}

/// Sealing failed (the system random source or the AEAD refused).
#[derive(Debug)]
pub struct SealError;

impl Cipher {
    /// A cipher over `key`.
    ///
    /// # Errors
    /// Never for a 32-byte key.
    pub fn new(key: &[u8; 32]) -> Result<Self, SealError> {
        let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| SealError)?;
        Ok(Self {
            key: LessSafeKey::new(unbound),
            rng: SystemRandom::new(),
        })
    }

    /// `seal`: a random nonce per value.
    ///
    /// # Errors
    /// The random source or the AEAD failed.
    pub fn seal(&self, plaintext: &str) -> Result<String, SealError> {
        let mut nonce = [0_u8; NONCE_BYTES];
        self.rng.fill(&mut nonce).map_err(|_| SealError)?;
        let mut body = plaintext.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut body)
            .map_err(|_| SealError)?;
        let mut raw = nonce.to_vec();
        raw.extend_from_slice(&body);
        Ok(format!("{VERSION}.{}", encode_base64url(&raw)))
    }

    /// `open` with this key only; `None` where TypeScript throws. Invalid UTF-8 becomes U+FFFD,
    /// as `Buffer.toString('utf8')` does.
    #[must_use]
    pub fn open(&self, sealed: &str) -> Option<String> {
        // const [version, payload] = sealed.split('.'): later parts are ignored.
        let mut parts = sealed.split('.');
        let version = parts.next()?;
        let payload = parts.next()?;
        if version != VERSION || payload.is_empty() {
            return None;
        }
        let raw = decode_base64_lenient(payload);
        if raw.len() < NONCE_BYTES + TAG_BYTES {
            return None;
        }
        let (nonce, rest) = raw.split_at(NONCE_BYTES);
        let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
        let mut body = rest.to_vec();
        let plain = self
            .key
            .open_in_place(nonce, Aad::empty(), &mut body)
            .ok()?;
        Some(String::from_utf8_lossy(plain).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;

    #[test]
    fn decodes_like_node() {
        // Observed with Node 22: Buffer.from(s, 'base64url').toString('hex').
        let hex = |s: &str| {
            decode_base64_lenient(s)
                .iter()
                .fold(String::new(), |mut out, b| {
                    let _ = write!(out, "{b:02x}");
                    out
                })
        };
        assert_eq!(hex("AAEC"), "000102");
        assert_eq!(hex("AAE"), "0001");
        assert_eq!(hex("A"), "");
        assert_eq!(hex("AA=A"), "00");
        assert_eq!(hex("A-_/+"), "03efff");
        assert_eq!(hex("AA EC"), "000102");
        assert_eq!(hex("AA*EC"), "000102");
        assert_eq!(hex("AAEC=AAEC"), "000102");
        assert_eq!(hex("=AAA"), "");
        assert_eq!(hex("ÿAAEC"), "000102");
        // Low byte of each UTF-16 unit, as observed with Node 22.
        assert_eq!(hex("ŁAEC"), "000102");
        assert_eq!(hex("AAšC"), hex("AAaC"));
        assert_eq!(hex("AAīC"), hex("AA+C"));
        assert_eq!(hex("AA😀EC"), "00");
        assert_eq!(encode_base64url(&[0, 1, 2, 3]), "AAECAw");
        assert_eq!(encode_base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn round_trips_and_rejects_other_keys() -> Result<(), SealError> {
        let a = Cipher::new(&[1; 32])?;
        let b = Cipher::new(&[2; 32])?;
        let sealed = a.seal("JBSWY3DPEHPK3PXP ñ😀")?;
        assert!(sealed.starts_with("v1."));
        assert_eq!(a.open(&sealed).as_deref(), Some("JBSWY3DPEHPK3PXP ñ😀"));
        assert_eq!(b.open(&sealed), None);
        assert_eq!(
            a.open(&format!("{sealed}.extra")).as_deref(),
            Some("JBSWY3DPEHPK3PXP ñ😀")
        );
        assert_eq!(a.open("v2.AAAA"), None);
        assert_eq!(a.open("v1."), None);
        assert_eq!(a.open("v1"), None);
        Ok(())
    }

    #[test]
    fn opens_a_value_sealed_by_node() {
        // Node 22: aes-256-gcm, key Buffer.alloc(32, 1), nonce 00..0b, plaintext 'secreto ñ'.
        let node = "v1.AAECAwQFBgcICQoLyMP2VEWKaVk929RMm6DSnR4mcFqEAoCZT60";
        let opened = Cipher::new(&[1; 32]).ok().and_then(|c| c.open(node));
        assert_eq!(opened.as_deref(), Some("secreto ñ"));
    }
}
