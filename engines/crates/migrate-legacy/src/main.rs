//! `migrate-legacy --legacy-root <dir> [options]`: same flags, output and exit codes as
//! `pnpm --filter @sipges/api migrate:legacy`. Runbook: docs/migration/data-migration.md. The
//! legacy installation is only ever read, and a dry run is the default.

use std::process::ExitCode;

use sipges_migrate_legacy::mapping::Fatal;
use sipges_migrate_legacy::run::{Deps, Mode, Options, run_migration};
use sipges_migrate_legacy::source::{Overrides, Source, legacy_layout};
use sipges_migrate_legacy::storage;
use sipges_migrate_legacy::store::Store;
use sipges_rotate_data_key::cipher::Cipher;
use sipges_tools_common::args::{self, Kind};
use sipges_tools_common::{db, env, migrate, time};

const USAGE: &str = "Usage: node src/tools/migrate-legacy/cli.ts --legacy-root <dir> [options]

Modes (default: dry-run)
  --dry-run                Read and report only; nothing is written.
  --apply                  Write into PostgreSQL (one transaction per tenant).
  --verify                 Compare source and target counts, checksums and attachment bytes.

Options
  --legacy-root <dir>      Legacy SIPGES checkout (expects <dir>/data/...).
  --auth-db <file>         Override auth_global.db (SIPGES_AUTH_DB_PATH).
  --default-db <file>      Override the default tenant database (SIPGES_DB_PATH).
  --tenant-dir <dir>       Override the tenant directory (SIPGES_TENANT_DIR).
  --upload-dir <dir>       Override the upload root (SIPGES_UPLOAD_DIR).
  --config-dir <dir>       Override the JSON configuration directory (<root>/data).
  --only <company/project> Restrict the run to one scope (repeatable).
  --allow-non-empty        Write even though the target already holds data.
  --report <file>          Write the JSON report to this path.
  --help                   Show this message.

Environment: the target database, data key and object storage come from the API configuration
(SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR, SIPGES_DATA_KEY, SIPGES_STORAGE...).";

const OPTIONS: [(&str, Kind); 13] = [
    ("legacy-root", Kind::String),
    ("auth-db", Kind::String),
    ("default-db", Kind::String),
    ("tenant-dir", Kind::String),
    ("upload-dir", Kind::String),
    ("config-dir", Kind::String),
    ("only", Kind::Strings),
    ("report", Kind::String),
    ("allow-non-empty", Kind::Boolean),
    ("apply", Kind::Boolean),
    ("verify", Kind::Boolean),
    ("dry-run", Kind::Boolean),
    ("help", Kind::Boolean),
];

/// Stack for recursion over JSON nested up to 100,000 levels.
const STACK_BYTES: usize = 512 * 1024 * 1024;

/// TypeScript lets these escape as a stack trace; a driver or parser message could quote a
/// value, so only the error's name and an operator-supplied path are printed.
fn fail(fatal: &Fatal) -> ExitCode {
    match &fatal.message {
        Some(message) => eprintln!("{}: {message}", fatal.name),
        None => eprintln!("{}", fatal.name),
    }
    ExitCode::from(1)
}

fn named(name: &'static str) -> ExitCode {
    fail(&Fatal::named(name))
}

/// `/^[^/]+\/[^/]+$/`.
fn valid_scope(scope: &str) -> bool {
    scope
        .split_once('/')
        .is_some_and(|(c, p)| !c.is_empty() && !p.is_empty() && !p.contains('/'))
}

/// The `z.string().min(1)` options and the `--only` pattern; Zod reports every field at once.
fn options_valid(values: &args::Values) -> bool {
    let filled = OPTIONS
        .iter()
        .filter(|(_, kind)| *kind == Kind::String)
        .all(|(name, _)| args::string(values, name) != Some(""));
    filled && args::strings(values, "only").iter().all(|s| valid_scope(s))
}

fn run(values: &args::Values, legacy_root: &str, mode: Mode) -> Result<ExitCode, ExitCode> {
    let process_env = env::process_env;
    let error = |_| named("Error");
    let data_key = env::data_key(&process_env).map_err(error)?;
    let url = env::database_url(&process_env).map_err(error)?;
    let object_storage = storage::from_env(&process_env).map_err(error)?;
    let layout = legacy_layout(
        legacy_root,
        Overrides {
            auth_db: args::string(values, "auth-db"),
            default_db: args::string(values, "default-db"),
            tenant_dir: args::string(values, "tenant-dir"),
            upload_dir: args::string(values, "upload-dir"),
            config_dir: args::string(values, "config-dir"),
        },
    )
    .map_err(|fatal| fail(&fatal))?;
    let source = Source::open(layout).map_err(|fatal| fail(&fatal))?;
    let mut client = db::connect(&url).map_err(|e| named(db::error_name(&e)))?;
    migrate::migrate(&mut client).map_err(|e| {
        named(match e.version {
            None if e.cause.as_db_error().is_some() => "PostgresError",
            _ => "Error",
        })
    })?;
    let cipher = Cipher::new(&data_key).map_err(|_| named("Error"))?;
    let mut store = Store::new(client, url, cipher);
    let report = run_migration(
        Deps {
            source: &source,
            store: &mut store,
            storage: &object_storage,
            now: &|| time::to_iso_string(time::now_ms()).unwrap_or_default(),
        },
        Options {
            mode,
            allow_non_empty: args::flag(values, "allow-non-empty"),
            only: args::strings(values, "only"),
        },
    )
    .map_err(|fatal| fail(&fatal))?;
    println!("{}", report.summarize());
    if let Some(path) = args::string(values, "report") {
        std::fs::write(path, format!("{}\n", report.to_json())).map_err(|_| named("Error"))?;
    }
    Ok(ExitCode::from(u8::from(!report.ok)))
}

fn run_cli() -> ExitCode {
    let Ok(values) = args::parse(&args::raw_args(), &OPTIONS) else {
        return named("TypeError");
    };
    if !options_valid(&values) {
        return named("ZodError");
    }
    let (apply, verify) = (args::flag(&values, "apply"), args::flag(&values, "verify"));
    if apply && verify {
        return fail(&Fatal {
            name: "Error",
            message: Some("Choose either --apply or --verify".to_owned()),
        });
    }
    let help = args::flag(&values, "help");
    let root = args::string(&values, "legacy-root");
    let Some(root) = root.filter(|_| !help) else {
        println!("{USAGE}");
        return ExitCode::from(if help { 0 } else { 2 });
    };
    let mode = if apply {
        Mode::Apply
    } else if verify {
        Mode::Verify
    } else {
        Mode::DryRun
    };
    run(&values, root, mode).unwrap_or_else(|code| code)
}

fn main() -> ExitCode {
    std::thread::Builder::new()
        .stack_size(STACK_BYTES)
        .spawn(run_cli)
        .ok()
        .and_then(|handle| handle.join().ok())
        .unwrap_or_else(|| named("Error"))
}
