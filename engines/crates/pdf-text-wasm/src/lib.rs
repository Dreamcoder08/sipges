//! WebAssembly ABI of the PDF text reader: `alloc`, `compute`, `dealloc` (engines/README.md).
//!
//! The request is binary, because it carries a PDF:
//!
//! - `C` + JavaScript source: compiles it to `QuickJS` bytecode (the build step, `pdfjs.qbc`).
//! - `R` + `max_pages` (u32 LE) + `budget_ms` (u32 LE) + `bytecode_len` (u32 LE) + bytecode + PDF:
//!   reads the PDF.
//!
//! The first response byte is `1` when the call worked; the rest is the bytecode or the JSON text
//! that `js/driver.js` wrote. A response starting with `0` is a failure and has no detail.

// FFI flags and sizes: small constants, and every length fits in the 32 bits of wasm32.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::unnecessary_cast
)]

use std::alloc::{Layout, alloc as raw_alloc, dealloc as raw_dealloc};
use std::ffi::{CStr, c_int, c_void};
use std::ptr::{NonNull, null_mut};
use std::time::{Duration, Instant};

use rquickjs_sys as q;

const FILE_NAME: &CStr = c"pdfjs.js";
const START: &CStr = c"__start";
const STEP: &CStr = c"__step";
const OUTPUT: &CStr = c"__output";
/// Linear memory is the real bound (the host caps it); this one fails cleanly before a trap.
const MEMORY_LIMIT: usize = 224 << 20;
/// About V8's own stack, and below the 2 MiB of `build.rs`. Each JavaScript frame also takes far
/// more of wazero's native stack, which lives on the Go heap: 7 MiB here let a 3 MiB PDF of nested
/// forms reach 1 GiB of memory.
const STACK_LIMIT: usize = 1 << 20;

const OP_COMPILE: u8 = b'C';
const OP_READ: u8 = b'R';

/// A `QuickJS` runtime and context, freed together. No `std` or `os` module exists in it: the
/// script has no file, clock or network function to call.
struct Engine {
    runtime: *mut q::JSRuntime,
    context: *mut q::JSContext,
}

impl Engine {
    fn new() -> Option<Self> {
        // SAFETY: plain constructor calls; the results are checked before use.
        unsafe {
            let runtime = q::JS_NewRuntime();
            if runtime.is_null() {
                return None;
            }
            q::JS_SetMemoryLimit(runtime, MEMORY_LIMIT as _);
            q::JS_SetMaxStackSize(runtime, STACK_LIMIT as _);
            let context = q::JS_NewContext(runtime);
            if context.is_null() {
                q::JS_FreeRuntime(runtime);
                return None;
            }
            Some(Self { runtime, context })
        }
    }

    /// Stops running scripts once `deadline` passes. `deadline` must outlive `self`.
    fn stop_at(&self, deadline: &Instant) {
        unsafe extern "C" fn expired(_: *mut q::JSRuntime, opaque: *mut c_void) -> c_int {
            // SAFETY: `opaque` is the `Instant` given to `stop_at`, alive for the whole call.
            let deadline = unsafe { &*opaque.cast::<Instant>() };
            c_int::from(Instant::now() >= *deadline)
        }
        let opaque = std::ptr::from_ref(deadline).cast_mut().cast();
        // SAFETY: the runtime is alive and the handler only reads `opaque`.
        unsafe { q::JS_SetInterruptHandler(self.runtime, Some(expired), opaque) };
    }

    /// Frees `value` and answers whether it was not an exception.
    fn succeeded(&self, value: q::JSValue) -> bool {
        // SAFETY: `value` is owned here and the context is alive.
        unsafe {
            let ok = !q::JS_IsException(value);
            q::JS_FreeValue(self.context, value);
            if !ok {
                q::JS_FreeValue(self.context, q::JS_GetException(self.context));
            }
            ok
        }
    }

    fn compile(&self, source: &[u8]) -> Option<Vec<u8>> {
        // JS_Eval needs a NUL after the source.
        let mut text = source.to_vec();
        text.push(0);
        // SAFETY: `text` is NUL-terminated and outlives the call; `written` is freed once.
        unsafe {
            let flags = (q::JS_EVAL_TYPE_GLOBAL | q::JS_EVAL_FLAG_COMPILE_ONLY) as c_int;
            let function = q::JS_Eval(
                self.context,
                text.as_ptr().cast(),
                source.len() as _,
                FILE_NAME.as_ptr(),
                flags,
            );
            if q::JS_IsException(function) {
                return None;
            }
            let mut size = 0;
            let written = q::JS_WriteObject(
                self.context,
                &raw mut size,
                function,
                q::JS_WRITE_OBJ_BYTECODE as c_int,
            );
            q::JS_FreeValue(self.context, function);
            if written.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(written, size as usize).to_vec();
            q::js_free(self.context, written.cast());
            Some(bytes)
        }
    }

    fn load(&self, bytecode: &[u8]) -> Option<()> {
        // SAFETY: the bytes are this module's own compiler output (`pdfjs.qbc`), never user input.
        unsafe {
            let function = q::JS_ReadObject(
                self.context,
                bytecode.as_ptr(),
                bytecode.len() as _,
                q::JS_READ_OBJ_BYTECODE as c_int,
            );
            if q::JS_IsException(function) {
                return None;
            }
            self.succeeded(q::JS_EvalFunction(self.context, function))
                .then_some(())
        }
    }

    /// Calls a global function with its arguments; takes ownership of `args`.
    fn call(&self, name: &CStr, args: &mut [q::JSValue]) -> Option<q::JSValue> {
        // SAFETY: every value is owned here and freed once; the context is alive.
        unsafe {
            let global = q::JS_GetGlobalObject(self.context);
            let function = q::JS_GetPropertyStr(self.context, global, name.as_ptr());
            let result = q::JS_Call(
                self.context,
                function,
                global,
                args.len() as c_int,
                args.as_mut_ptr(),
            );
            q::JS_FreeValue(self.context, function);
            q::JS_FreeValue(self.context, global);
            for arg in args.iter() {
                q::JS_FreeValue(self.context, *arg);
            }
            if q::JS_IsException(result) {
                q::JS_FreeValue(self.context, q::JS_GetException(self.context));
                return None;
            }
            Some(result)
        }
    }

    /// Runs promise jobs and, when none is left, the next timer; `None` once the script is stuck
    /// or a job failed in a way JavaScript could not catch.
    fn run_until_done(&self, deadline: Instant) -> Option<()> {
        loop {
            loop {
                let mut context = null_mut();
                // SAFETY: the runtime is alive; `context` is only written.
                let ran = unsafe { q::JS_ExecutePendingJob(self.runtime, &raw mut context) };
                if ran < 0 {
                    return None;
                }
                if ran == 0 {
                    break;
                }
                if Instant::now() >= deadline {
                    return None;
                }
            }
            // `__step` answers 1 after running a timer, 0 when done, -1 when nothing can run.
            let step = self.call(STEP, &mut [])?;
            // SAFETY: an integer value owns nothing.
            match unsafe { q::JS_VALUE_GET_INT(step) } {
                1 => {}
                0 => return Some(()),
                _ => return None,
            }
        }
    }

    fn output(&self) -> Option<Vec<u8>> {
        let text = self.call(OUTPUT, &mut [])?;
        // SAFETY: `text` is owned here; the C string is copied and freed before returning.
        unsafe {
            let mut len = 0;
            let raw = q::JS_ToCStringLen(self.context, &raw mut len, text);
            q::JS_FreeValue(self.context, text);
            if raw.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(raw.cast::<u8>(), len as usize).to_vec();
            q::JS_FreeCString(self.context, raw);
            Some(bytes)
        }
    }

    fn read(&self, bytecode: &[u8], pdf: &[u8], max_pages: u32) -> Option<()> {
        self.load(bytecode)?;
        // SAFETY: the buffer is copied by QuickJS; the value is owned by `call`.
        let buffer =
            unsafe { q::JS_NewArrayBufferCopy(self.context, pdf.as_ptr(), pdf.len() as _) };
        let pages = q::JS_MKVAL(q::JS_TAG_INT, i32::try_from(max_pages).ok()?);
        let done = self.call(START, &mut [buffer, pages])?;
        // SAFETY: `done` is owned here.
        unsafe { q::JS_FreeValue(self.context, done) };
        Some(())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: both pointers are valid and freed once, context first.
        unsafe {
            q::JS_FreeContext(self.context);
            q::JS_FreeRuntime(self.runtime);
        }
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    let field = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes(field.try_into().ok()?))
}

fn read_pdf(request: &[u8]) -> Option<Vec<u8>> {
    let max_pages = u32_at(request, 0)?;
    let budget = u64::from(u32_at(request, 4)?);
    let bytecode_len = usize::try_from(u32_at(request, 8)?).ok()?;
    let body = request.get(12..)?;
    let (bytecode, pdf) = body.split_at_checked(bytecode_len)?;
    let deadline = Instant::now() + Duration::from_millis(budget);
    let engine = Engine::new()?;
    engine.stop_at(&deadline);
    engine.read(bytecode, pdf, max_pages)?;
    engine.run_until_done(deadline)?;
    engine.output()
}

fn dispatch(request: &[u8]) -> Option<Vec<u8>> {
    let (op, rest) = request.split_first()?;
    match *op {
        OP_COMPILE => Engine::new()?.compile(rest),
        OP_READ => read_pdf(rest),
        _ => None,
    }
}

/// Runs one request; see the crate documentation for its shape.
#[must_use]
pub fn respond(request: &[u8]) -> Vec<u8> {
    match dispatch(request) {
        Some(mut output) => {
            output.insert(0, 1);
            output
        }
        None => vec![0],
    }
}

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
        None => null_mut(),
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

/// Runs the request at `ptr..ptr+len` and returns `(out_ptr << 32) | out_len`; the host reads the
/// response and frees it with `dealloc(out_ptr, out_len)`.
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
    let output = respond(input).into_boxed_slice();
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

    fn bytecode(source: &str) -> Vec<u8> {
        let mut request = vec![OP_COMPILE];
        request.extend_from_slice(source.as_bytes());
        let response = respond(&request);
        assert_eq!(response.first(), Some(&1), "the source compiles");
        response.get(1..).unwrap_or_default().to_vec()
    }

    fn read(source: &str, pdf: &[u8], budget_ms: u32) -> Vec<u8> {
        let code = bytecode(source);
        let mut request = vec![OP_READ];
        request.extend_from_slice(&7u32.to_le_bytes());
        request.extend_from_slice(&budget_ms.to_le_bytes());
        request.extend_from_slice(&u32::try_from(code.len()).unwrap_or(0).to_le_bytes());
        request.extend_from_slice(&code);
        request.extend_from_slice(pdf);
        respond(&request)
    }

    const ECHO: &str = "let out = '';
        globalThis.__start = (b, n) => { out = new Uint8Array(b).length + '/' + n; };
        globalThis.__step = () => 0;
        globalThis.__output = () => out;";

    #[test]
    fn a_read_hands_the_pdf_and_the_page_limit_to_the_script() {
        assert_eq!(read(ECHO, b"abc", 1000), b"\x013/7");
    }

    #[test]
    fn timers_run_only_when_the_script_asks_for_another_step() {
        let source = "let n = 0;
            globalThis.__start = () => {};
            globalThis.__step = () => (++n < 3 ? 1 : 0);
            globalThis.__output = () => String(n);";
        assert_eq!(read(source, b"", 1000), b"\x013");
    }

    #[test]
    fn a_script_that_never_ends_stops_at_its_budget() {
        let source = "globalThis.__start = () => { for (;;); };
            globalThis.__step = () => 0;
            globalThis.__output = () => '';";
        assert_eq!(read(source, b"", 50), [0]);
    }

    #[test]
    fn steps_that_never_end_stop_at_the_budget_too() {
        let source = "globalThis.__start = () => {};
            globalThis.__step = () => { for (;;); };
            globalThis.__output = () => '';";
        assert_eq!(read(source, b"", 50), [0]);
    }

    #[test]
    fn a_script_with_nothing_left_to_run_fails() {
        let source = "globalThis.__start = () => {};
            globalThis.__step = () => -1;
            globalThis.__output = () => '';";
        assert_eq!(read(source, b"", 1000), [0]);
    }

    #[test]
    fn memory_beyond_the_limit_is_a_failure_not_a_crash() {
        let source = "globalThis.__start = () => { const a = []; for (;;) a.push(new Uint8Array(1 << 24)); };
            globalThis.__step = () => 0;
            globalThis.__output = () => '';";
        assert_eq!(read(source, b"", 5000), [0]);
    }

    #[test]
    fn the_runtime_has_no_file_or_clock_module() {
        let source = "globalThis.__start = () => {};
            globalThis.__step = () => 0;
            globalThis.__output = () => [typeof std, typeof os, typeof require].join();";
        assert_eq!(
            read(source, b"", 1000),
            b"\x01undefined,undefined,undefined"
        );
    }

    #[test]
    fn a_malformed_request_is_a_failure() {
        assert_eq!(respond(b""), [0]);
        assert_eq!(respond(b"X"), [0]);
        assert_eq!(respond(b"R\x01"), [0]);
        assert_eq!(respond(b"C syntax error ("), [0]);
        let mut oversized = vec![OP_READ];
        oversized.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
        assert_eq!(respond(&oversized), [0]);
    }
}
