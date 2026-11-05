//! `util.parseArgs({ strict: true })` without positionals, as the TypeScript tool CLIs call it
//! (after dropping every `--` argument). Any parse error is a `TypeError` in Node.

use std::collections::BTreeMap;

/// Option kinds `parseArgs` accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `{ type: 'string' }`.
    String,
    /// `{ type: 'boolean' }`.
    Boolean,
}

/// A parsed value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// A string option's last value.
    String(String),
    /// A boolean option given at least once.
    Flag,
}

/// Node's `ERR_PARSE_ARGS_*` code; the CLIs only report the error's name, `TypeError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    /// The Node error code.
    pub code: &'static str,
}

/// Parsed options by long name; options not given are absent.
pub type Values = BTreeMap<&'static str, Value>;

/// Node's `isOptionLikeValue`: a string of two or more characters starting with `-`.
fn option_like(value: &str) -> bool {
    value.len() > 1 && value.starts_with('-')
}

/// Parses `argv` (without the `--` separators) against long `options`.
///
/// # Errors
/// The `ParseError` Node throws: unknown option, positional argument, missing or ambiguous
/// string value, or a value given to a boolean.
pub fn parse(argv: &[String], options: &[(&'static str, Kind)]) -> Result<Values, ParseError> {
    let find = |name: &str| options.iter().find(|(known, _)| *known == name).copied();
    let mut values = Values::new();
    let mut index = 0;
    while let Some(arg) = argv.get(index) {
        index += 1;
        if arg == "--" {
            // End of options: whatever follows is positional, which strict mode refuses.
            if argv.len() > index {
                return Err(ParseError {
                    code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
                });
            }
            break;
        }
        let Some(long) = arg.strip_prefix("--") else {
            if option_like(arg) {
                // Short options (`-x`, `-xyz`): none is declared.
                return Err(ParseError {
                    code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
                });
            }
            return Err(ParseError {
                code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
            });
        };
        let (name, inline) = match long.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (long, None),
        };
        let Some((name, kind)) = find(name) else {
            return Err(ParseError {
                code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
            });
        };
        match (kind, inline) {
            (Kind::Boolean, Some(_)) => {
                return Err(ParseError {
                    code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
                });
            }
            (Kind::Boolean, None) => {
                values.insert(name, Value::Flag);
            }
            (Kind::String, Some(value)) => {
                values.insert(name, Value::String(value.to_owned()));
            }
            (Kind::String, None) => match argv.get(index) {
                Some(next) if !option_like(next) => {
                    index += 1;
                    values.insert(name, Value::String(next.clone()));
                }
                _ => {
                    return Err(ParseError {
                        code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
                    });
                }
            },
        }
    }
    Ok(values)
}

/// The CLI's arguments without the `--` separators pnpm forwards (`args.filter((a) => a !== '--')`).
#[must_use]
pub fn cli_args() -> Vec<String> {
    std::env::args().skip(1).filter(|arg| arg != "--").collect()
}

/// A string option's value.
#[must_use]
pub fn string<'a>(values: &'a Values, name: &str) -> Option<&'a str> {
    match values.get(name) {
        Some(Value::String(value)) => Some(value),
        _ => None,
    }
}

/// Whether a boolean option was given.
#[must_use]
pub fn flag(values: &Values, name: &str) -> bool {
    matches!(values.get(name), Some(Value::Flag))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: &[(&str, Kind)] = &[
        ("scope", Kind::String),
        ("apply", Kind::Boolean),
        ("help", Kind::Boolean),
    ];

    fn run(given: &[&str]) -> Result<Values, &'static str> {
        let argv: Vec<String> = given.iter().map(|a| (*a).to_owned()).collect();
        parse(&argv, OPTIONS).map_err(|e| e.code)
    }

    #[test]
    fn matches_node_parse_args() {
        // Each case was observed with Node 22's util.parseArgs.
        let invalid = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
        assert_eq!(run(&["--scope"]), Err(invalid));
        assert_eq!(run(&["--scope", "--apply"]), Err(invalid));
        assert_eq!(run(&["--apply=1"]), Err(invalid));
        assert_eq!(run(&["--scope", "-a/b"]), Err(invalid));
        assert_eq!(run(&["x"]), Err("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"));
        assert_eq!(run(&["-"]), Err("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"));
        assert_eq!(run(&["-s"]), Err("ERR_PARSE_ARGS_UNKNOWN_OPTION"));
        assert_eq!(run(&["--nope"]), Err("ERR_PARSE_ARGS_UNKNOWN_OPTION"));
        let values = run(&["--scope=-a/b"]).unwrap_or_default();
        assert_eq!(string(&values, "scope"), Some("-a/b"));
        let values =
            run(&["--scope", "a/b", "--scope", "c/d", "--apply", "--apply"]).unwrap_or_default();
        assert_eq!(string(&values, "scope"), Some("c/d"));
        assert!(flag(&values, "apply"));
        let values = run(&["--scope="]).unwrap_or_default();
        assert_eq!(string(&values, "scope"), Some(""));
        assert!(run(&["--apply", "--"]).is_ok());
        assert_eq!(
            run(&["--apply", "--", "x"]),
            Err("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL")
        );
        let values = run(&["--scope", "-"]).unwrap_or_default();
        assert_eq!(string(&values, "scope"), Some("-"));
    }
}
