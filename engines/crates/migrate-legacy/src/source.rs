//! `infrastructure/sqlite-legacy-source.ts`: read-only access to a legacy installation. SQLite
//! files open in read-only mode, and nothing here writes to the legacy side.

use std::fs;
use std::path::Path;
use std::rc::Rc;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::json::{self, Json, ParseError};
use crate::mapping::{Fatal, Scope, scope_digest, stored_name_safe};
use crate::value::{Legacy, Row, js_string};

const DEFAULT_COMPANY: &str = "SIPGES";
const DEFAULT_PROJECT: &str = "PRJ-SECHURA";
/// `Number.MAX_SAFE_INTEGER`: `node:sqlite` throws `RangeError` past it, on either side of zero.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// `path.normalize`'s segment walk (POSIX).
fn normalize_segments(path: &str, above_root: bool) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| *last != "..") {
                    out.pop();
                } else if above_root {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

/// `path.normalize`.
#[must_use]
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let mut body = normalize_segments(path, !absolute);
    if body.is_empty() {
        if absolute {
            return "/".to_owned();
        }
        return if path.ends_with('/') { "./" } else { "." }.to_owned();
    }
    if path.ends_with('/') {
        body.push('/');
    }
    if absolute { format!("/{body}") } else { body }
}

/// `path.join(a, b)`.
#[must_use]
pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => ".".to_owned(),
        (false, true) => normalize(a),
        (true, false) => normalize(b),
        (false, false) => normalize(&format!("{a}/{b}")),
    }
}

/// `path.resolve(path)`.
///
/// # Errors
/// The working directory cannot be read.
pub fn resolve(path: &str) -> Result<String, Fatal> {
    if path.starts_with('/') {
        return Ok(format!("/{}", normalize_segments(path, false)));
    }
    let cwd = std::env::current_dir().map_err(|_| Fatal::named("Error"))?;
    let joined = format!("{}/{path}", cwd.to_string_lossy());
    Ok(format!("/{}", normalize_segments(&joined, false)))
}

/// Where a legacy installation keeps its files.
#[derive(Clone, Debug)]
pub struct Layout {
    /// `auth_global.db`.
    pub auth_db: String,
    /// The default tenant's database.
    pub default_db: String,
    /// Non-default tenants' databases and settings.
    pub tenant_dir: String,
    /// Upload root.
    pub upload_dir: String,
    /// The default scope's JSON configuration.
    pub config_dir: String,
}

/// `--auth-db` and friends, each already non-empty.
#[derive(Clone, Copy, Debug, Default)]
pub struct Overrides<'a> {
    /// `--auth-db`.
    pub auth_db: Option<&'a str>,
    /// `--default-db`.
    pub default_db: Option<&'a str>,
    /// `--tenant-dir`.
    pub tenant_dir: Option<&'a str>,
    /// `--upload-dir`.
    pub upload_dir: Option<&'a str>,
    /// `--config-dir`.
    pub config_dir: Option<&'a str>,
}

/// `legacyLayout`.
///
/// # Errors
/// The working directory cannot be read.
pub fn legacy_layout(root: &str, overrides: Overrides<'_>) -> Result<Layout, Fatal> {
    let data = join(&resolve(root)?, "data");
    let or =
        |value: Option<&str>, name: &str| value.map_or_else(|| join(&data, name), str::to_owned);
    Ok(Layout {
        auth_db: or(overrides.auth_db, "auth_global.db"),
        default_db: or(overrides.default_db, "sipges.db"),
        tenant_dir: or(overrides.tenant_dir, "tenants"),
        upload_dir: or(overrides.upload_dir, "uploads"),
        config_dir: overrides
            .config_dir
            .map_or_else(|| data.clone(), str::to_owned),
    })
}

fn open_read_only(path: &str) -> Result<Connection, Fatal> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| Fatal::named("Error"))?;
    // node:sqlite does not wait for a lock.
    connection
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| Fatal::named("Error"))?;
    Ok(connection)
}

/// `selectAll`: a table created lazily by app.py is simply absent in older installations.
fn select_all(db: &Connection, table: &str, order_by: &str) -> Result<Vec<Row>, Fatal> {
    let error = |_| Fatal::named("Error");
    let exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .and_then(|mut statement| statement.exists([table]))
        .map_err(error)?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = db
        .prepare(&format!("SELECT * FROM {table} ORDER BY {order_by}"))
        .map_err(error)?;
    let names: Rc<[String]> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let columns = names.len();
    let mut rows = statement.query([]).map_err(error)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(error)? {
        let mut values = Vec::with_capacity(columns);
        for column in 0..columns {
            values.push(match row.get_ref(column).map_err(error)? {
                ValueRef::Null => Legacy::Null,
                ValueRef::Integer(n) if n.unsigned_abs() > MAX_SAFE_INTEGER => {
                    return Err(Fatal::named("RangeError"));
                }
                ValueRef::Integer(n) => Legacy::Num(as_f64(n)),
                ValueRef::Real(x) => Legacy::Num(x),
                ValueRef::Text(bytes) => Legacy::Text(String::from_utf8_lossy(bytes).into_owned()),
                ValueRef::Blob(bytes) => Legacy::Blob(bytes.to_vec()),
            });
        }
        out.push(Row::new(Rc::clone(&names), values));
    }
    Ok(out)
}

/// Exact: the caller checked the range.
#[allow(clippy::cast_precision_loss)]
const fn as_f64(n: i64) -> f64 {
    n as f64
}

/// Files of one scope.
#[derive(Clone, Debug)]
struct TenantPaths {
    db: String,
    upload_root: String,
    irsa_config: String,
    default_irsa_config: String,
}

fn tenant_paths(layout: &Layout, scope: &Scope) -> TenantPaths {
    let default_irsa_config = join(&layout.config_dir, "irsa_config.json");
    if scope.company == DEFAULT_COMPANY && scope.project == DEFAULT_PROJECT {
        return TenantPaths {
            db: layout.default_db.clone(),
            upload_root: layout.upload_dir.clone(),
            irsa_config: default_irsa_config.clone(),
            default_irsa_config,
        };
    }
    let digest = scope_digest(&scope.tenant_id());
    TenantPaths {
        db: join(&layout.tenant_dir, &format!("{digest}.db")),
        upload_root: join(&layout.upload_dir, &digest),
        irsa_config: join(
            &layout.tenant_dir,
            &format!("{digest}_settings/irsa_config.json"),
        ),
        default_irsa_config,
    }
}

/// `irsaConfig()`.
#[derive(Clone, Debug, PartialEq)]
pub enum IrsaConfig {
    /// No file.
    Absent,
    /// A file that cannot be parsed, or not an object.
    Invalid,
    /// The parsed object.
    Object(Json),
    /// An object nested too deep for `hasNul`.
    TooDeep,
}

/// `readJsonObject`.
fn read_json_object(path: &str) -> IrsaConfig {
    if !Path::new(path).exists() {
        return IrsaConfig::Absent;
    }
    let Ok(bytes) = fs::read(path) else {
        return IrsaConfig::Invalid;
    };
    let text = String::from_utf8_lossy(&bytes);
    match json::parse(&text) {
        Err(ParseError::Syntax) => IrsaConfig::Invalid,
        Err(ParseError::TooDeep) if !json::opens_object(&text) => IrsaConfig::Invalid,
        Err(ParseError::TooDeep) => IrsaConfig::TooDeep,
        Ok(parsed) => match parsed.value {
            object @ Json::Obj(_) if parsed.depth > crate::mapping::MAX_JSON_DEPTH => {
                drop(object);
                IrsaConfig::TooDeep
            }
            object @ Json::Obj(_) => IrsaConfig::Object(object),
            _ => IrsaConfig::Invalid,
        },
    }
}

/// `readIrsaConfig`: a scope without its own file gets the default scope's, as app.py copies it.
fn read_irsa_config(paths: &TenantPaths) -> (IrsaConfig, bool) {
    if Path::new(&paths.irsa_config).exists() || paths.irsa_config == paths.default_irsa_config {
        return (read_json_object(&paths.irsa_config), false);
    }
    let config = read_json_object(&paths.default_irsa_config);
    let inherited = config != IrsaConfig::Absent;
    (config, inherited)
}

/// A grant as listed: `String(x ?? '')` of each column.
#[derive(Clone, Debug)]
pub struct LegacyGrant {
    /// Account name, untrimmed.
    pub username: String,
    /// `company/project`.
    pub tenant_id: String,
}

fn string_or_empty(value: &Legacy) -> String {
    js_string(value).unwrap_or_default()
}

/// One legacy tenant.
#[derive(Debug)]
pub struct TenantReader {
    db: Option<Connection>,
    upload_root: String,
    paths: TenantPaths,
}

impl TenantReader {
    /// Whether the SQLite file exists.
    #[must_use]
    pub const fn present(&self) -> bool {
        self.db.is_some()
    }

    fn rows(&self, table: &str, order_by: &str) -> Result<Vec<Row>, Fatal> {
        self.db
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |db| select_all(db, table, order_by))
    }

    /// `records`.
    ///
    /// # Errors
    /// `SQLite` failures and integers JavaScript cannot hold.
    pub fn records(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("records", "module, record_id")
    }

    /// `audit`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn audit(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("audit", "id")
    }

    /// `irsa_snapshots`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn snapshots(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("irsa_snapshots", "id")
    }

    /// `attachments`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn attachments(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("attachments", "created_at, id")
    }

    /// `document_review`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn document_reviews(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("document_review", "created_at, id")
    }

    /// `digital_alert_reviews`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn alerts(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("digital_alert_reviews", "created_at, id")
    }

    /// `preventive_actions`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn actions(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("preventive_actions", "created_at, id")
    }

    /// `preventive_action_log`.
    ///
    /// # Errors
    /// As [`Self::records`].
    pub fn action_log(&self) -> Result<Vec<Row>, Fatal> {
        self.rows("preventive_action_log", "created_at, id")
    }

    /// The scope's IRSA configuration and whether it is inherited.
    #[must_use]
    pub fn irsa_config(&self) -> (IrsaConfig, bool) {
        read_irsa_config(&self.paths)
    }

    /// `readObject`: a stored name is one path component, and a symlink is never followed,
    /// because the default scope's root also holds every other tenant's folder.
    #[must_use]
    pub fn read_object(&self, stored_name: &str) -> Option<Vec<u8>> {
        if self.db.is_none() || !stored_name_safe(stored_name) {
            return None;
        }
        let path = resolve(&join(&self.upload_root, stored_name)).ok()?;
        if !path.starts_with(&format!("{}/", self.upload_root)) {
            return None;
        }
        if !fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        fs::read(&path).ok()
    }
}

/// The legacy installation; owns the auth database handle.
#[derive(Debug)]
pub struct Source {
    layout: Layout,
    auth: Connection,
}

impl Source {
    /// `createSqliteLegacySource`.
    ///
    /// # Errors
    /// The auth database is missing or cannot be opened.
    pub fn open(layout: Layout) -> Result<Self, Fatal> {
        if !Path::new(&layout.auth_db).exists() {
            return Err(Fatal {
                name: "Error",
                message: Some(format!(
                    "Legacy auth database not found: {}",
                    layout.auth_db
                )),
            });
        }
        let auth = open_read_only(&layout.auth_db)?;
        Ok(Self { layout, auth })
    }

    /// `scopes()`.
    ///
    /// # Errors
    /// `SQLite` failures and integers JavaScript cannot hold.
    pub fn scopes(&self) -> Result<Vec<Scope>, Fatal> {
        Ok(
            select_all(&self.auth, "tenant_projects", "company_id, project_id")?
                .iter()
                .map(|row| Scope {
                    company: string_or_empty(row.get("company_id")),
                    project: string_or_empty(row.get("project_id")),
                    label: string_or_empty(row.get("label")),
                })
                .collect(),
        )
    }

    /// `users()`.
    ///
    /// # Errors
    /// As [`Self::scopes`].
    pub fn users(&self) -> Result<Vec<Row>, Fatal> {
        select_all(&self.auth, "auth_users", "username")
    }

    /// `grants()`.
    ///
    /// # Errors
    /// As [`Self::scopes`].
    pub fn grants(&self) -> Result<Vec<LegacyGrant>, Fatal> {
        let order = "username, company_id, project_id";
        Ok(select_all(&self.auth, "access_grants", order)?
            .iter()
            .map(|row| LegacyGrant {
                username: string_or_empty(row.get("username")),
                tenant_id: format!(
                    "{}/{}",
                    string_or_empty(row.get("company_id")),
                    string_or_empty(row.get("project_id"))
                ),
            })
            .collect())
    }

    /// `sessionCount()`: sessions are deliberately not migrated, only counted.
    ///
    /// # Errors
    /// As [`Self::scopes`].
    pub fn session_count(&self) -> Result<usize, Fatal> {
        Ok(select_all(&self.auth, "auth_sessions", "token_hash")?.len())
    }

    /// `openTenant`.
    ///
    /// # Errors
    /// The tenant's file exists but cannot be opened, or the working directory is unreadable.
    pub fn open_tenant(&self, scope: &Scope) -> Result<TenantReader, Fatal> {
        let paths = tenant_paths(&self.layout, scope);
        let db = if Path::new(&paths.db).exists() {
            Some(open_read_only(&paths.db)?)
        } else {
            None
        };
        Ok(TenantReader {
            db,
            upload_root: resolve(&paths.upload_root)?,
            paths,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::json::units;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    /// A legacy installation in the system temp directory, removed on drop.
    struct Install {
        root: PathBuf,
    }

    impl Drop for Install {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    impl Install {
        fn new(name: &str) -> Option<Self> {
            let root = std::env::temp_dir().join(format!(
                "sipges-migrate-legacy-{}-{name}",
                std::process::id()
            ));
            let install = Self { root };
            fs::create_dir_all(install.path("data/uploads")).ok()?;
            fs::create_dir_all(install.path("data/tenants")).ok()?;
            for db in ["data/auth_global.db", "data/sipges.db"] {
                Connection::open(install.path(db)).ok()?;
            }
            Some(install)
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn write(&self, relative: &str, content: &str) -> Option<()> {
            let path = self.path(relative);
            fs::create_dir_all(path.parent()?).ok()?;
            fs::write(path, content).ok()
        }

        fn source(&self) -> Option<Source> {
            let root = self.root.to_string_lossy();
            Source::open(legacy_layout(&root, Overrides::default()).ok()?).ok()
        }

        fn tenant(&self, scope: &Scope) -> Option<TenantReader> {
            self.source()?.open_tenant(scope).ok()
        }
    }

    fn scope(company: &str, project: &str) -> Scope {
        Scope {
            company: company.to_owned(),
            project: project.to_owned(),
            label: String::new(),
        }
    }

    fn default_scope() -> Scope {
        scope(DEFAULT_COMPANY, DEFAULT_PROJECT)
    }

    #[test]
    fn read_object_stays_inside_the_tenants_root() -> Result<(), &'static str> {
        let install = Install::new("read-object").ok_or("install")?;
        install
            .write("data/uploads/abc_a.txt", "bytes")
            .ok_or("write")?;
        install.write("data/uploads/vacio.txt", "").ok_or("write")?;
        install.write("data/fuera.txt", "fuera").ok_or("write")?;
        let digest = scope_digest("A/B");
        install
            .write(&format!("data/uploads/{digest}/ajeno.txt"), "ajeno")
            .ok_or("write")?;
        fs::create_dir(install.path("data/uploads/carpeta")).map_err(|_| "dir")?;
        symlink(
            install.path("data/fuera.txt"),
            install.path("data/uploads/enlace.txt"),
        )
        .map_err(|_| "symlink")?;
        let reader = install.tenant(&default_scope()).ok_or("tenant")?;

        assert_eq!(reader.read_object("abc_a.txt"), Some(b"bytes".to_vec()));
        assert_eq!(reader.read_object("vacio.txt"), Some(Vec::new()));
        for refused in [
            "no-esta.txt",
            "enlace.txt",
            "carpeta",
            "../fuera.txt",
            "..",
            ".",
            "",
            "a\\b",
            "a\0",
            "/etc/hostname",
        ] {
            assert_eq!(reader.read_object(refused), None, "{refused:?}");
        }
        // The default scope's root holds every other tenant's folder.
        let foreign = format!("{digest}/ajeno.txt");
        assert_eq!(reader.read_object(&foreign), None);
        Ok(())
    }

    #[test]
    fn read_object_reads_only_a_tenants_own_folder() -> Result<(), &'static str> {
        let install = Install::new("own-folder").ok_or("install")?;
        let digest = scope_digest("A/B");
        Connection::open(install.path(&format!("data/tenants/{digest}.db"))).map_err(|_| "db")?;
        install
            .write(&format!("data/uploads/{digest}/propio.txt"), "propio")
            .ok_or("write")?;
        install
            .write("data/uploads/del-defecto.txt", "ajeno")
            .ok_or("write")?;
        let reader = install.tenant(&scope("A", "B")).ok_or("tenant")?;
        assert_eq!(reader.read_object("propio.txt"), Some(b"propio".to_vec()));
        assert_eq!(reader.read_object("del-defecto.txt"), None);
        Ok(())
    }

    #[test]
    fn a_tenant_without_a_database_reads_nothing() -> Result<(), &'static str> {
        let install = Install::new("no-database").ok_or("install")?;
        let digest = scope_digest("A/B");
        install
            .write(&format!("data/uploads/{digest}/x.txt"), "x")
            .ok_or("write")?;
        let reader = install.tenant(&scope("A", "B")).ok_or("tenant")?;
        assert!(!reader.present());
        assert_eq!(reader.read_object("x.txt"), None);
        assert_eq!(reader.records().map(|rows| rows.len()), Ok(0));
        Ok(())
    }

    fn object(key: &str, value: f64) -> IrsaConfig {
        IrsaConfig::Object(Json::Obj(vec![(units(key), Json::Num(value))]))
    }

    #[test]
    fn irsa_config_reads_each_state() -> Result<(), &'static str> {
        let install = Install::new("irsa").ok_or("install")?;
        let other = scope("A", "B");
        let settings = format!(
            "data/tenants/{}_settings/irsa_config.json",
            scope_digest("A/B")
        );
        let default_file = "data/irsa_config.json";

        let read = |who: &Scope| install.tenant(who).map(|reader| reader.irsa_config());
        assert_eq!(read(&default_scope()), Some((IrsaConfig::Absent, false)));
        assert_eq!(read(&other), Some((IrsaConfig::Absent, false)));

        install.write(default_file, "{\"v\":1}").ok_or("write")?;
        assert_eq!(read(&default_scope()), Some((object("v", 1.0), false)));
        assert_eq!(read(&other), Some((object("v", 1.0), true)));

        install.write(&settings, "{\"v\":2}").ok_or("write")?;
        assert_eq!(read(&other), Some((object("v", 2.0), false)));

        for invalid in ["{mal", "[1]", "null", "\u{feff}{}"] {
            install.write(&settings, invalid).ok_or("write")?;
            assert_eq!(
                read(&other),
                Some((IrsaConfig::Invalid, false)),
                "{invalid}"
            );
        }
        let deep = format!("{{\"x\":{}1{}}}", "[".repeat(1001), "]".repeat(1001));
        install.write(&settings, &deep).ok_or("write")?;
        assert_eq!(read(&other), Some((IrsaConfig::TooDeep, false)));
        fs::remove_file(install.path(&settings)).map_err(|_| "remove")?;
        fs::create_dir(install.path(&settings)).map_err(|_| "dir")?;
        assert_eq!(read(&other), Some((IrsaConfig::Invalid, false)));
        fs::remove_dir(install.path(&settings)).map_err(|_| "remove")?;

        // An invalid default still counts as inherited: the scope has no file of its own.
        install.write(default_file, "{mal").ok_or("write")?;
        assert_eq!(read(&other), Some((IrsaConfig::Invalid, true)));
        Ok(())
    }

    #[test]
    fn refuses_integers_javascript_cannot_hold() {
        let read = |n: i64| {
            let db = Connection::open_in_memory().ok()?;
            db.execute_batch("CREATE TABLE t(a)").ok()?;
            db.execute("INSERT INTO t VALUES (?)", [n]).ok()?;
            Some(select_all(&db, "t", "a").map(|rows| rows.len()))
        };
        assert_eq!(read(9_007_199_254_740_991), Some(Ok(1)));
        assert_eq!(read(-9_007_199_254_740_991), Some(Ok(1)));
        for n in [
            9_007_199_254_740_992,
            -9_007_199_254_740_992,
            i64::MIN,
            i64::MAX,
        ] {
            assert_eq!(read(n), Some(Err(Fatal::named("RangeError"))), "{n}");
        }
    }

    #[test]
    fn paths_match_node() {
        // Observed with Node: path.normalize, path.join, path.resolve.
        for (input, expected) in [
            ("", "."),
            ("a/../..", ".."),
            ("/..", "/"),
            ("./", "./"),
            ("/a//b/./c/../", "/a/b/"),
            ("a/b/", "a/b/"),
            ("../a", "../a"),
        ] {
            assert_eq!(normalize(input), expected, "{input:?}");
        }
        assert_eq!(join("/a/b", "../c"), "/a/c");
        assert_eq!(join("", ""), ".");
        assert_eq!(join("a/", ""), "a/");
        assert_eq!(resolve("/a/../b/"), Ok("/b".to_owned()));
        assert_eq!(resolve("/"), Ok("/".to_owned()));
    }

    #[test]
    fn scopes_map_to_their_files() {
        let layout = legacy_layout("/srv/x/", Overrides::default());
        assert!(
            layout
                .as_ref()
                .is_ok_and(|l| l.auth_db == "/srv/x/data/auth_global.db")
        );
        assert!(layout.as_ref().is_ok_and(|l| l.config_dir == "/srv/x/data"));
        let Ok(layout) = layout else { return };
        let scope = |company: &str, project: &str| Scope {
            company: company.to_owned(),
            project: project.to_owned(),
            label: String::new(),
        };
        let default = tenant_paths(&layout, &scope("SIPGES", "PRJ-SECHURA"));
        assert_eq!(default.db, "/srv/x/data/sipges.db");
        assert_eq!(default.upload_root, "/srv/x/data/uploads");
        let digest = scope_digest("A/B");
        let other = tenant_paths(&layout, &scope("A", "B"));
        assert_eq!(other.db, format!("/srv/x/data/tenants/{digest}.db"));
        assert_eq!(other.upload_root, format!("/srv/x/data/uploads/{digest}"));
    }
}
