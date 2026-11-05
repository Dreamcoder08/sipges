//! `rotate-data-key [--dry-run | --apply] [--report <file>]`: same flags, output and exit codes
//! as `pnpm --filter @sipges/api rotate:data-key`. Procedure: docs/operations/data-key-rotation.md.
//! Keys come only from the environment; output holds counts and row identifiers only.

use std::process::ExitCode;

use sipges_rotate_data_key::rotate;
use sipges_tools_common::args::{self, Kind};
use sipges_tools_common::{db, env};

const USAGE: &str =
    "Usage: node src/tools/rotate-data-key/cli.ts [--dry-run | --apply] [--report <file>]

Modes (default: dry-run)
  --dry-run          Count values per table and column; nothing is written.
  --apply            Re-encrypt stale values (one transaction per table or tenant).

Options
  --report <file>    Also write the JSON report (counts and row identifiers only).
  --help             Show this message.

Environment
  SIPGES_DATA_KEY           The NEW key (base64, 32 bytes).
  SIPGES_DATA_KEY_PREVIOUS  The OLD key being rotated out.
  SIPGES_DATABASE_URL       Target PostgreSQL (or SIPGES_PGLITE_DIR for a local copy).";

/// An error TypeScript does not catch: Node prints it with a stack trace and exits 1.
fn uncaught(kind: &str, message: &str) -> ExitCode {
    eprintln!("{kind}: {message}");
    ExitCode::from(1)
}

/// Node's message for a failed `writeFile`, for the common causes.
fn write_error(path: &str, error: &std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT: no such file or directory",
        std::io::ErrorKind::PermissionDenied => "EACCES: permission denied",
        std::io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory",
        _ => return error.to_string(),
    };
    format!("{code}, open '{path}'")
}

fn stopped(message: &str) -> ExitCode {
    eprintln!("Rotation stopped: {message}");
    eprintln!("That unit was rolled back; earlier units may be committed. Re-run to resume.");
    ExitCode::from(1)
}

fn main() -> ExitCode {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    // pnpm forwards the `--` of `pnpm … rotate:data-key -- --apply` to the script.
    if argv.first().is_some_and(|a| a == "--") {
        argv.remove(0);
    }
    let options = [
        ("apply", Kind::Boolean),
        ("dry-run", Kind::Boolean),
        ("report", Kind::String),
        ("help", Kind::Boolean),
    ];
    let values = match args::parse(&argv, &options) {
        Ok(values) => values,
        Err(error) => return uncaught("TypeError", error.code),
    };
    let apply = args::flag(&values, "apply");
    if apply && args::flag(&values, "dry-run") {
        return uncaught("Error", "Choose either --apply or --dry-run");
    }
    if args::flag(&values, "help") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let new_key = match env::data_key(&env::process_env) {
        Ok(key) => key,
        Err(error) => return uncaught("Error", &error.0),
    };
    let old_key = match env::process_env("SIPGES_DATA_KEY_PREVIOUS") {
        None => {
            eprintln!("SIPGES_DATA_KEY_PREVIOUS (the old key) is required.\n");
            println!("{USAGE}");
            return ExitCode::from(2);
        }
        Some(value) => match env::decode_data_key("SIPGES_DATA_KEY_PREVIOUS", &value) {
            Ok(key) => key,
            Err(error) => return uncaught("Error", &error.0),
        },
    };
    let url = match env::database_url(&env::process_env) {
        Ok(url) => url,
        Err(error) => return uncaught("Error", &error.0),
    };
    let mut client = match db::connect(&url) {
        Ok(client) => client,
        Err(db::ConnectError::Driver(error)) => {
            return stopped(&rotate::Failure::from(error).0);
        }
        Err(error) => return stopped(&error.to_string()),
    };
    let report = match rotate::rotate(&mut client, &old_key, &new_key, apply) {
        Ok(report) => report,
        Err(failure) => return stopped(&failure.0),
    };
    println!("{}", report.summarize());
    if let Some(path) = args::string(&values, "report") {
        let text = match serde_json::to_string_pretty(&report.to_json()) {
            Ok(text) => text,
            Err(error) => return stopped(&error.to_string()),
        };
        if let Err(error) = std::fs::write(path, format!("{text}\n")) {
            return stopped(&write_error(path, &error));
        }
    }
    ExitCode::from(u8::from(!report.ok))
}
