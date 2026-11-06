//! The C stack of the wasm module is linear memory, so `QuickJS` must stop below its size.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=-zstack-size=2097152");
    }
}
