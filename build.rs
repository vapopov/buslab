use std::{env, fs, path::PathBuf};
fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let layout = if env::var_os("CARGO_FEATURE_XIAO_UF2").is_some() {
        "memory-xiao-uf2.x"
    } else {
        "memory-swd.x"
    };
    fs::copy(layout, out.join("buslab-memory.x")).unwrap();
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rerun-if-changed=memory-swd.x");
    println!("cargo:rerun-if-changed=memory-xiao-uf2.x");
}
