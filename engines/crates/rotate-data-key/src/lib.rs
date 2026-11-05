//! Rust port of `apps/api/src/tools/rotate-data-key` (T43): re-encrypts every value sealed with
//! the old `SIPGES_DATA_KEY` under the new one, byte-compatible with the API's secret cipher.

pub mod cipher;
pub mod rotate;
