//! `contexts/evidence/infrastructure`: object storage under the API's configuration, as files on
//! a local disk or through an S3-compatible API.

use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use sipges_tools_common::env::ConfigError;
use sipges_tools_common::js;
use sipges_tools_common::time::to_iso_string;
use ureq::http::HeaderValue;

use crate::mapping::sha256_hex;
use crate::source::{join, resolve};

/// A storage failure; TypeScript's message can quote a server reply, so it is never printed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageError;

/// The scheme and authority of `SIPGES_S3_ENDPOINT`; any path in it is ignored, as
/// `new URL(path, endpoint)` ignores it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    secure: bool,
    /// `url.host`: lower case, without the scheme's default port.
    host: String,
}

/// The endpoint's parts, or `None` for anything but `http(s)://host[:port][/…]`. Stricter than
/// `new URL`, which also accepts credentials, a missing `//` and more.
fn parse_endpoint(text: &str) -> Option<(Endpoint, bool)> {
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let secure = match scheme.as_str() {
        "https" => true,
        "http" => false,
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if authority.is_empty()
        || authority.contains('@')
        || !authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
    {
        return None;
    }
    let (hostname, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        (authority.get(..=end)?, authority.get(end + 1..)?)
    } else {
        match authority.find(':') {
            Some(at) => (authority.get(..at)?, authority.get(at..)?),
            None => (authority.as_str(), ""),
        }
    };
    if !(port.is_empty() || (port.len() > 1 && port.starts_with(':'))) {
        return None;
    }
    let number = port
        .strip_prefix(':')
        .map(str::parse::<u16>)
        .transpose()
        .ok()?;
    let default = if secure { 443 } else { 80 };
    let host = match number {
        Some(n) if n != default => format!("{hostname}:{n}"),
        _ => hostname.to_owned(),
    };
    let local = matches!(hostname, "localhost" | "127.0.0.1" | "[::1]");
    Some((Endpoint { secure, host }, local))
}

/// An S3-compatible API.
#[derive(Debug)]
pub struct S3 {
    endpoint: Endpoint,
    region: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    agent: ureq::Agent,
}

/// `createObjectStorage`'s two adapters.
#[derive(Debug)]
pub enum Storage {
    /// Files under a directory.
    Local {
        /// `resolve(root)`.
        base: String,
    },
    /// Boxed: the agent is much larger than a path.
    S3(Box<S3>),
}

/// `parseStorage`, then `createObjectStorage`.
///
/// # Errors
/// The configuration errors of `apps/api/src/platform/config.ts`.
pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Result<Storage, ConfigError> {
    let kind = env("SIPGES_STORAGE").unwrap_or_else(|| "local".to_owned());
    if kind == "local" {
        let dir = env("SIPGES_UPLOAD_DIR").unwrap_or_else(|| ".data/uploads".to_owned());
        let base = resolve(&dir).map_err(|_| ConfigError("working directory".to_owned()))?;
        return Ok(Storage::Local { base });
    }
    if kind != "s3" {
        return Err(ConfigError("SIPGES_STORAGE must be 'local' or 's3'".into()));
    }
    let required = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConfigError(format!("{name} is required when SIPGES_STORAGE=s3")))
    };
    let text = required("SIPGES_S3_ENDPOINT")?;
    let (endpoint, local) = parse_endpoint(&text)
        .ok_or_else(|| ConfigError("SIPGES_S3_ENDPOINT must be an absolute URL".into()))?;
    if !endpoint.secure && !local {
        return Err(ConfigError(
            "SIPGES_S3_ENDPOINT must use https (http only for a local test server)".into(),
        ));
    }
    let bucket = required("SIPGES_S3_BUCKET")?;
    let access_key_id = required("SIPGES_S3_ACCESS_KEY_ID")?;
    let secret_access_key = required("SIPGES_S3_SECRET_ACCESS_KEY")?;
    let timeouts = |seconds| Some(std::time::Duration::from_secs(seconds));
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        // Node's fetch reads no proxy from the environment. A redirect would carry a signature
        // made for another URL, so the reply stands as it is.
        .proxy(None)
        .max_redirects(0)
        .timeout_connect(timeouts(30))
        .timeout_recv_response(timeouts(300))
        .build()
        .new_agent();
    Ok(Storage::S3(Box::new(S3 {
        endpoint,
        region: env("SIPGES_S3_REGION").unwrap_or_else(|| "auto".to_owned()),
        bucket,
        access_key_id,
        secret_access_key,
        agent,
    })))
}

/// `/^[0-9a-f]{24}\/[A-Za-z0-9._-]+$/`.
fn valid_key(key: &str) -> bool {
    let Some((prefix, name)) = key.split_once('/') else {
        return false;
    };
    prefix.len() == 24
        && prefix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `pathFor`.
fn path_for(base: &str, key: &str) -> Result<String, StorageError> {
    if !valid_key(key) {
        return Err(StorageError);
    }
    let path = resolve(&join(base, key)).map_err(|_| StorageError)?;
    if path.starts_with(&format!("{base}/")) {
        Ok(path)
    } else {
        Err(StorageError)
    }
}

/// Writes through a temporary file renamed into place, so a crash leaves no truncated object.
fn put_local(base: &str, key: &str, bytes: &[u8]) -> Result<(), StorageError> {
    let path = path_for(base, key)?;
    let parent = path.rsplit_once('/').map_or("/", |(dir, _)| dir);
    fs::create_dir_all(parent).map_err(|_| StorageError)?;
    let mut random = [0_u8; 6];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| StorageError)?;
    let temporary = format!(
        "{path}.{}.tmp",
        sha256_hex(&random).get(..12).unwrap_or("0")
    );
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| file.write_all(bytes));
    written.map_err(|_| StorageError)?;
    fs::rename(&temporary, &path).map_err(|_| StorageError)
}

fn get_local(base: &str, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
    let path = path_for(base, key)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StorageError),
    }
}

/// `encodeSegment`: RFC 3986 encoding.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `amzDate`: `20261105T010203Z`.
fn amz_date(at: std::time::SystemTime) -> String {
    let compact = to_iso_string(at)
        .unwrap_or_default()
        .replace(['-', ':'], "");
    let seconds = compact.split('.').next().unwrap_or(&compact);
    format!("{seconds}Z")
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
        .as_ref()
        .to_vec()
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `value.trim().replace(/\s+/g, ' ')`.
fn canonical_header_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in js::trim(value).chars() {
        if js::is_js_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

impl S3 {
    /// `signRequest`: the `Authorization` value. `headers` are `(name, value)`, without `host`.
    fn sign(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        hash: &str,
        date: &str,
    ) -> String {
        let day = date.get(..8).unwrap_or(date);
        let scope = format!("{day}/{}/s3/aws4_request", self.region);
        let mut canonical: Vec<(String, String)> = headers
            .iter()
            .chain([("host", self.endpoint.host.as_str())].iter())
            .map(|(name, value)| (name.to_ascii_lowercase(), canonical_header_value(value)))
            .collect();
        canonical.sort();
        let signed = canonical
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(";");
        let lines = canonical
            .iter()
            .map(|(name, value)| format!("{name}:{value}"))
            .collect::<Vec<_>>()
            .join("\n");
        let request = format!("{method}\n{path}\n\n{lines}\n\n{signed}\n{hash}");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
            sha256_hex(request.as_bytes())
        );
        let mut key = format!("AWS4{}", self.secret_access_key).into_bytes();
        for part in [day, self.region.as_str(), "s3", "aws4_request"] {
            key = hmac_sha256(&key, part);
        }
        let signature = to_hex(&hmac_sha256(&key, &string_to_sign));
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}",
            self.access_key_id
        )
    }

    fn path(&self, key: &str) -> String {
        let segments: Vec<String> = key.split('/').map(encode_segment).collect();
        format!("/{}/{}", encode_segment(&self.bucket), segments.join("/"))
    }

    fn url(&self, path: &str) -> String {
        let scheme = if self.endpoint.secure {
            "https"
        } else {
            "http"
        };
        format!("{scheme}://{}{path}", self.endpoint.host)
    }

    fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StorageError> {
        let path = self.path(key);
        let hash = sha256_hex(bytes);
        let date = amz_date(std::time::SystemTime::now());
        let mut headers = vec![
            ("x-amz-content-sha256", hash.as_str()),
            ("x-amz-date", date.as_str()),
        ];
        if !content_type.is_empty() {
            headers.push(("content-type", content_type));
        }
        let authorization = self.sign("PUT", &path, &headers, &hash, &date);
        let mut request = self
            .agent
            .put(self.url(&path))
            .header("x-amz-content-sha256", hash.as_str())
            .header("x-amz-date", date.as_str())
            .header("authorization", authorization.as_str());
        if !content_type.is_empty() {
            request = request.header("content-type", header_bytes(content_type)?);
        }
        let response = request.send(bytes).map_err(|_| StorageError)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(StorageError)
        }
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let path = self.path(key);
        let hash = sha256_hex(b"");
        let date = amz_date(std::time::SystemTime::now());
        let headers = [
            ("x-amz-content-sha256", hash.as_str()),
            ("x-amz-date", date.as_str()),
        ];
        let authorization = self.sign("GET", &path, &headers, &hash, &date);
        let mut response = self
            .agent
            .get(self.url(&path))
            .header("x-amz-content-sha256", hash.as_str())
            .header("x-amz-date", date.as_str())
            .header("authorization", authorization.as_str())
            .call()
            .map_err(|_| StorageError)?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(StorageError);
        }
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map(Some)
            .map_err(|_| StorageError)
    }
}

/// A header value as fetch sends it: Latin-1 bytes, surrounding HTTP whitespace removed, and an
/// error for a character past U+00FF, a line break or NUL.
fn header_bytes(value: &str) -> Result<HeaderValue, StorageError> {
    let bytes = value
        .trim_matches(['\t', '\n', '\r', ' '])
        .chars()
        .map(|c| u8::try_from(u32::from(c)).map_err(|_| StorageError))
        .collect::<Result<Vec<u8>, _>>()?;
    HeaderValue::from_bytes(&bytes).map_err(|_| StorageError)
}

impl Storage {
    /// `put`.
    ///
    /// # Errors
    /// An invalid key, or the disk or server refused.
    pub fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StorageError> {
        match self {
            Self::Local { base } => put_local(base, key, bytes),
            Self::S3(s3) => s3.put(key, bytes, content_type),
        }
    }

    /// `get`: `None` when the object does not exist.
    ///
    /// # Errors
    /// An invalid key, or the disk or server refused.
    pub fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        match self {
            Self::Local { base } => get_local(base, key),
            Self::S3(s3) => s3.get(key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn reads_endpoints_like_new_url() {
        let (endpoint, local) = parse_endpoint("HTTPS://Bucket.Example.com:443/x?y")
            .unwrap_or_else(|| {
                (
                    Endpoint {
                        secure: false,
                        host: String::new(),
                    },
                    true,
                )
            });
        assert_eq!(
            endpoint,
            Endpoint {
                secure: true,
                host: "bucket.example.com".into()
            }
        );
        assert!(!local);
        for local_url in [
            "http://127.0.0.1:9000",
            "http://localhost",
            "http://[::1]:9000/p",
        ] {
            assert!(
                parse_endpoint(local_url).is_some_and(|(_, local)| local),
                "{local_url}"
            );
        }
        for bad in [
            "no es una url",
            "ftp://a",
            "http://",
            "http://u:p@h",
            "http://a:b",
            "http://a:",
        ] {
            assert_eq!(parse_endpoint(bad), None, "{bad}");
        }
    }

    #[test]
    fn signs_the_aws_get_object_example() {
        // docs.aws.amazon.com: Authenticating Requests (AWS Signature Version 4), GET Object,
        // the example the API's s3-signature test also pins, minus its `range` header.
        let s3 = S3 {
            endpoint: Endpoint {
                secure: true,
                host: "examplebucket.s3.amazonaws.com".into(),
            },
            region: "us-east-1".into(),
            bucket: "examplebucket".into(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            agent: ureq::Agent::new_with_defaults(),
        };
        let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let date = "20130524T000000Z";
        let headers = [
            ("range", "bytes=0-9"),
            ("x-amz-content-sha256", hash),
            ("x-amz-date", date),
        ];
        let signed = s3.sign("GET", "/test.txt", &headers, hash, date);
        assert!(
            signed.ends_with(
                "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
            ),
            "{signed}"
        );
    }

    #[test]
    fn encodes_and_dates_like_typescript() {
        assert_eq!(
            encode_segment("a b/ñ!'()*~"),
            "a%20b%2F%C3%B1%21%27%28%29%2A~"
        );
        let at = UNIX_EPOCH + Duration::from_millis(1_793_836_800_123);
        assert_eq!(amz_date(at), "20261105T000000Z");
        assert_eq!(canonical_header_value("  a \t  b\n"), "a b");
    }

    #[test]
    fn checks_object_keys() {
        let prefix = "0".repeat(24);
        assert!(valid_key(&format!("{prefix}/a.txt")));
        assert!(!valid_key(&format!("{prefix}/a/b")));
        assert!(!valid_key(&format!("{prefix}/")));
        assert!(!valid_key("short/a"));
    }

    #[test]
    fn refuses_header_values_fetch_refuses() {
        assert!(header_bytes("text/plain; charset=é").is_ok());
        assert!(header_bytes("a\nb").is_err());
        assert!(header_bytes("😀").is_err());
    }
}
