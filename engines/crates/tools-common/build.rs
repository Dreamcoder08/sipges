//! Embeds the API's SQL migrations (`apps/api/src/platform/database/migrations/NNNN_name.sql`),
//! so a tool binary applies exactly the migrations of the commit it was built from, as the
//! TypeScript tools do with `loadMigrations()`.

use std::fmt::Write as _;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let dir = manifest.join("../../../apps/api/src/platform/database/migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        // Same filter as loadMigrations: /^\d{4}_[a-z0-9_]+\.sql$/.
        let Some(stem) = name.strip_suffix(".sql") else {
            continue;
        };
        let bytes = stem.as_bytes();
        let ok = bytes.len() > 5
            && bytes.iter().take(4).all(u8::is_ascii_digit)
            && bytes.get(4) == Some(&b'_')
            && bytes
                .iter()
                .skip(5)
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_');
        if ok {
            println!("cargo:rerun-if-changed={}", dir.join(&name).display());
            files.push(name);
        }
    }
    // JavaScript's default sort compares UTF-16 units; these names are ASCII, so bytes agree.
    files.sort();
    let mut out = String::from(
        "/// Embedded migrations, sorted by version.\npub static MIGRATIONS: &[Migration] = &[\n",
    );
    for name in &files {
        let path = dir.join(name);
        let version = name.trim_end_matches(".sql");
        writeln!(
            out,
            "    Migration {{ version: {version:?}, sql: include_str!({path:?}) }},",
            path = path.display().to_string()
        )?;
    }
    out.push_str("];\n");
    std::fs::write(
        PathBuf::from(std::env::var("OUT_DIR")?).join("migrations.rs"),
        out,
    )?;
    Ok(())
}
