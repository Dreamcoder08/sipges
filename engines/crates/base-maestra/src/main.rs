//! `import-base-maestra --seed <file> [--scope C/P] [--apply]`: same flags, output and exit
//! codes as `pnpm --filter @sipges/api import:base-maestra`. Runbook: docs/migration/base-maestra.md.
//! Output holds module names, counts and positions only, never record values.

use std::io::Write as _;
use std::process::ExitCode;

use sipges_base_maestra::run;
use sipges_tools_common::args::{self, Kind};
use sipges_tools_common::{db, env, migrate, time};

const USAGE: &str =
    "Usage: node src/tools/base-maestra/cli.ts --seed <file> [--scope SIPGES/PRJ-SECHURA] [--apply]
Target database: SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR (the API configuration).";

fn fail(name: &str) -> ExitCode {
    // Parser and driver errors can echo values or connection details; report the class only.
    eprintln!("Importación de Base Maestra fallida: {name}");
    ExitCode::from(1)
}

/// `/^[^/]+\/[^/]+$/`.
fn valid_scope(scope: &str) -> bool {
    scope
        .split_once('/')
        .is_some_and(|(c, p)| !c.is_empty() && !p.is_empty() && !p.contains('/'))
}

/// `path.basename` (POSIX).
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.is_empty() { "" } else { "/" }
            .get(..0)
            .unwrap_or("");
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// Stack for the parser's recursion (JSON nested up to 100,000 levels).
const STACK_BYTES: usize = 512 * 1024 * 1024;

fn main() -> ExitCode {
    std::thread::Builder::new()
        .stack_size(STACK_BYTES)
        .spawn(run_cli)
        .ok()
        .and_then(|handle| handle.join().ok())
        .unwrap_or_else(|| fail("Error"))
}

fn run_cli() -> ExitCode {
    let options = [
        ("seed", Kind::String),
        ("scope", Kind::String),
        ("apply", Kind::Boolean),
        ("help", Kind::Boolean),
    ];
    let Ok(values) = args::parse(&args::cli_args(), &options) else {
        return fail("TypeError");
    };
    let help = args::flag(&values, "help");
    let seed_path = args::string(&values, "seed").filter(|s| !s.is_empty());
    let scope = args::string(&values, "scope").unwrap_or("SIPGES/PRJ-SECHURA");
    let Some(seed_path) = seed_path.filter(|_| !help && valid_scope(scope)) else {
        println!("{USAGE}");
        return ExitCode::from(if help { 0 } else { 2 });
    };
    let apply = args::flag(&values, "apply");
    // readFile(…, 'utf8') replaces invalid UTF-8; JSON.parse then runs on the text.
    let Ok(bytes) = std::fs::read(seed_path) else {
        return fail("Error");
    };
    let Ok(seed) = sipges_base_maestra::json::parse(&String::from_utf8_lossy(&bytes)) else {
        return fail("SyntaxError");
    };
    if env::data_key(&env::process_env).is_err() {
        return fail("Error");
    }
    let Ok(url) = env::database_url(&env::process_env) else {
        eprintln!("SIPGES_DATABASE_URL es obligatorio: las herramientas Rust no usan PGlite.");
        return fail("Error");
    };
    let mut client = match db::connect(&url) {
        Ok(client) => client,
        Err(error) => return fail(db::error_name(&error)),
    };
    if let Err(error) = migrate::migrate(&mut client) {
        return fail(match error.version {
            None if error.cause.as_db_error().is_some() => "PostgresError",
            _ => "Error",
        });
    }
    let found = match client.query(
        "SELECT tenant_id FROM tenants WHERE tenant_id = $1",
        &[&scope],
    ) {
        Ok(rows) => !rows.is_empty(),
        Err(error) => {
            return fail(if error.as_db_error().is_some() {
                "PostgresError"
            } else {
                "Error"
            });
        }
    };
    if !found {
        eprintln!("El proyecto {scope} no existe; inícielo desde la aplicación primero.");
        return ExitCode::from(1);
    }
    let report = match run::import(
        &mut client,
        scope,
        &seed,
        apply,
        basename(seed_path),
        &time::now_ms,
    ) {
        Ok(report) => report,
        Err(error) => return fail(error.js_name()),
    };
    let Ok(text) = serde_json::to_string_pretty(&report.to_json()) else {
        return fail("Error");
    };
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{text}").is_err() {
        return ExitCode::from(1);
    }
    if !apply
        && writeln!(
            out,
            "Simulación: no se escribió nada. Use --apply para importar."
        )
        .is_err()
    {
        return ExitCode::from(1);
    }
    ExitCode::from(u8::from(!report.problems.is_empty()))
}
