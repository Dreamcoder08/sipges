//! WebAssembly ABI of the SIPGES indicators engine (`wasm32-wasip1`), see engines/README.md.
//!
//! Exports, all with 32-bit linear-memory offsets:
//! - `alloc(len) -> ptr`: reserves `len` bytes for the request; `0` when allocation fails.
//! - `compute(ptr, len) -> u64`: runs the UTF-8 JSON request at `ptr..ptr+len` and returns the
//!   response location packed as `(out_ptr << 32) | out_len`. The request stays owned by the host.
//! - `dealloc(ptr, len)`: frees a buffer from `alloc` or a response from `compute`.
//!
//! This crate is the only place with `unsafe` (every block carries its `SAFETY` argument): it
//! turns host-provided offsets into slices.

use std::alloc::{Layout, alloc as raw_alloc, dealloc as raw_dealloc};
use std::ptr::NonNull;

fn layout(len: usize) -> Option<Layout> {
    Layout::array::<u8>(len).ok()
}

/// Reserves `len` bytes in linear memory and returns their offset (`0` on failure). A zero-length
/// request returns a dangling, aligned, non-null offset that must not be read.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return NonNull::<u8>::dangling().as_ptr();
    }
    match layout(len) {
        // SAFETY: the layout has a non-zero size.
        Some(layout) => unsafe { raw_alloc(layout) },
        None => std::ptr::null_mut(),
    }
}

/// Frees `len` bytes at `ptr`, previously returned by [`alloc`] or [`compute`].
///
/// # Safety
/// `ptr` and `len` must come from one earlier `alloc(len)` or `compute` response that was not
/// freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    if let Some(layout) = layout(len) {
        // SAFETY: guaranteed by the caller: `ptr` was allocated with this exact layout.
        unsafe { raw_dealloc(ptr, layout) };
    }
}

/// Runs the JSON request at `ptr..ptr+len` and returns `(out_ptr << 32) | out_len`; the host
/// reads the response and frees it with `dealloc(out_ptr, out_len)`.
///
/// # Safety
/// `ptr..ptr+len` must be initialised memory the module owns (normally a buffer from [`alloc`]
/// the host wrote the request into).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compute(ptr: *const u8, len: usize) -> u64 {
    let input: &[u8] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        // SAFETY: guaranteed by the caller; the slice does not outlive this call.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };
    let output = sipges_indicators::compute(input).into_boxed_slice();
    let out_len = output.len();
    // The boxed slice was allocated with `Layout::array::<u8>(out_len)`, which `dealloc` rebuilds.
    let out_ptr = Box::into_raw(output).cast::<u8>();
    pack(out_ptr as usize, out_len)
}

/// `(ptr << 32) | len`; both fit in 32 bits on wasm32.
fn pack(ptr: usize, len: usize) -> u64 {
    let ptr = u64::try_from(ptr).unwrap_or(0) & 0xffff_ffff;
    let len = u64::try_from(len).unwrap_or(0) & 0xffff_ffff;
    (ptr << 32) | len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_writes_and_frees_a_buffer() {
        let request = br#"{"op":"defaults"}"#;
        let ptr = alloc(request.len());
        assert!(!ptr.is_null());
        // SAFETY: `ptr` holds `request.len()` writable bytes from `alloc`.
        unsafe { std::ptr::copy_nonoverlapping(request.as_ptr(), ptr, request.len()) };
        // SAFETY: the bytes were initialised above and are freed only after this read.
        let written = unsafe { std::slice::from_raw_parts(ptr, request.len()) };
        assert_eq!(written, request);
        // SAFETY: freeing the buffer `alloc` returned, once.
        unsafe { dealloc(ptr, request.len()) };
        assert!(!alloc(0).is_null());
    }

    #[test]
    fn packs_offset_and_length() {
        assert_eq!(pack(0x10, 0x20), 0x0000_0010_0000_0020);
        assert_eq!(pack(0xffff_fff0, 7), 0xffff_fff0_0000_0007);
    }
}
