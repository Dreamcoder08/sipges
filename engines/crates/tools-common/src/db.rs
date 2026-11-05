//! PostgreSQL connection with the API's TLS rule (`apps/api/src/platform/database/postgres.ts`).

use std::sync::Arc;

use postgres::config::SslMode;
use postgres::{Client, Config, NoTls};

/// `/@(localhost|127\.0\.0\.1|\[::1\])[:/]/`: URLs whose host is the local machine.
#[must_use]
pub fn is_local(url: &str) -> bool {
    ["@localhost", "@127.0.0.1", "@[::1]"].iter().any(|host| {
        url.match_indices(host)
            .any(|(at, _)| matches!(url.as_bytes().get(at + host.len()), Some(b':' | b'/')))
    })
}

/// A connection error, already stripped of anything that could echo the URL.
#[derive(Debug)]
pub enum ConnectError {
    /// The URL is not one rust-postgres accepts.
    Url,
    /// The driver failed to connect or authenticate.
    Driver(postgres::Error),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Url => f.write_str("invalid database URL"),
            Self::Driver(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// Opens one connection. TLS is required unless the URL targets a local host, as in the API;
/// the Rust tools also verify the server certificate against the Mozilla roots (postgres.js
/// `ssl: 'require'` encrypts without verifying).
///
/// # Errors
/// An unparsable URL or a failed connection.
pub fn connect(url: &str) -> Result<Client, ConnectError> {
    let mut config: Config = url.parse().map_err(|_| ConnectError::Url)?;
    // postgres.js logs every notice with console.log; so do the tools.
    config.notice_callback(|notice| println!("{}", crate::notice::format(&notice)));
    // postgres.js gives up connecting after `connect_timeout` (30 s by default); without a
    // timeout an unreachable host would hang the tool. A URL `connect_timeout` still wins.
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(std::time::Duration::from_secs(30));
    }
    if is_local(url) {
        config.ssl_mode(SslMode::Disable);
        return config.connect(NoTls).map_err(ConnectError::Driver);
    }
    config.ssl_mode(SslMode::Require);
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| ConnectError::Url)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    config
        .connect(tokio_postgres_rustls::MakeRustlsConnect::new(tls))
        .map_err(ConnectError::Driver)
}

/// The error name the TypeScript CLIs print: postgres.js names server errors `PostgresError`;
/// everything else (connection, configuration, migration wrapper) is a plain `Error`.
#[must_use]
pub fn error_name(error: &(dyn std::error::Error + 'static)) -> &'static str {
    let driver = error.downcast_ref::<postgres::Error>().or_else(|| {
        match error.downcast_ref::<ConnectError>() {
            Some(ConnectError::Driver(error)) => Some(error),
            _ => None,
        }
    });
    if driver.is_some_and(|error| error.as_db_error().is_some()) {
        "PostgresError"
    } else {
        "Error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_local_hosts_like_the_api() {
        assert!(is_local("postgres://u:p@localhost:5432/db"));
        assert!(is_local("postgres://u@127.0.0.1/db"));
        assert!(is_local("postgres://u@[::1]:5432/db"));
        assert!(!is_local("postgres://u@localhost.example.com/db"));
        assert!(!is_local("postgres://u@db.example.com/db"));
        assert!(!is_local("postgres://localhost/db"));
    }
}
