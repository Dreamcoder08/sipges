//! `review-materialize [--scope C/P] [--apply]`: same flags, output and exit codes as
//! `pnpm --filter @sipges/api review:materialize`. Runbook: docs/operations/review-materialize.md
//! (production only with the owner's word).

use std::io::Write as _;
use std::process::ExitCode;

use sipges_review_materialize::run;
use sipges_tools_common::args::{self, Kind};
use sipges_tools_common::{db, env, migrate, time};

const USAGE: &str =
    "Usage: node src/tools/review-materialize/cli.ts [--scope SIPGES/PRJ-SECHURA] [--apply]
Target database: SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR (the API configuration).";

const FAILED: &str = "Creación de registros de revisión fallida:";

/// `/^[^/]+\/[^/]+$/`.
fn valid_scope(scope: &str) -> bool {
    scope.split_once('/').is_some_and(|(company, project)| {
        !company.is_empty() && !project.is_empty() && !project.contains('/')
    })
}

fn fail(name: &str) -> ExitCode {
    // Driver errors can echo values or connection details; report the class only.
    eprintln!("{FAILED} {name}");
    ExitCode::from(1)
}

fn main() -> ExitCode {
    let options = [
        ("scope", Kind::String),
        ("apply", Kind::Boolean),
        ("help", Kind::Boolean),
    ];
    let Ok(values) = args::parse(&args::cli_args(), &options) else {
        return fail("TypeError");
    };
    let scope = args::string(&values, "scope");
    let help = args::flag(&values, "help");
    if help || scope.is_some_and(|s| !valid_scope(s)) {
        println!("{USAGE}");
        return ExitCode::from(if help { 0 } else { 2 });
    }
    let apply = args::flag(&values, "apply");
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
        // postgres.js connects on the first query, so a refused login surfaces here unwrapped;
        // a failing migration is wrapped in a plain Error.
        let name = match error.version {
            None if error.cause.as_db_error().is_some() => "PostgresError",
            _ => "Error",
        };
        return fail(name);
    }
    let scope = scope.filter(|s| !s.is_empty());
    let report = match run::run(&mut client, apply, scope, &time::now_ms) {
        Ok(report) => report,
        Err(error) => return fail(error.js_name()),
    };
    if !report.missing.is_empty() {
        eprintln!("El proyecto {} no existe.", report.missing.join(", "));
        return ExitCode::from(1);
    }
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
            "Simulación: no se escribió nada. Use --apply para crear."
        )
        .is_err()
    {
        return ExitCode::from(1);
    }
    ExitCode::from(u8::from(
        report.tenants.iter().any(|t| !t.problems.is_empty()),
    ))
}
