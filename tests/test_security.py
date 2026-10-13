import re, shutil, subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import ADMIN_PASSWORD, BASE_URL, ORIGIN

ROOT = Path(__file__).resolve().parents[1]


def login(client, username="admin", password=ADMIN_PASSWORD, otp=""):
    return client.post("/login", data={"username": username, "password": password, "otp": otp}, headers=ORIGIN)


def enroll_mfa(app_module, client):
    secret = client.post("/system/auth/totp/setup", headers=ORIGIN).json()["secret"]
    r = client.post("/system/auth/totp/enable", json={"code": app_module.totp_code(secret)}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    return secret


def admin_session(app_module, client):
    assert login(client).status_code == 200
    return enroll_mfa(app_module, client)


def test_security_headers_on_public_and_private_responses(app_module, client):
    for r in (client.get("/health"), client.get("/login")):
        csp = r.headers["content-security-policy"]
        assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "max-age=" in r.headers["strict-transport-security"]


def test_session_cookie_is_secure_by_default(client):
    r = login(client)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "secure" in cookie and "httponly" in cookie and "samesite=strict" in cookie


def test_secure_cookie_can_be_disabled_for_local_http(app_module, monkeypatch):
    monkeypatch.setenv("MASCLI_COOKIE_SECURE", "0")
    with TestClient(app_module.app, base_url="http://testserver") as c:
        r = c.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD}, headers={"Origin": "http://testserver"})
        assert r.status_code == 200
        assert "secure" not in r.headers["set-cookie"].lower()
        assert "strict-transport-security" not in r.headers


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://evil.example"}, {"Referer": "https://evil.example/x"}])
def test_state_changing_requests_require_same_origin(client, headers):
    r = client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD}, headers=headers)
    assert r.status_code == 403


def test_referer_is_accepted_when_origin_is_absent(client):
    r = client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD}, headers={"Referer": BASE_URL + "/login"})
    assert r.status_code == 200


def test_login_is_rate_limited_after_repeated_failures(client):
    for _ in range(5):
        assert login(client, password="incorrecta-incorrecta").status_code == 401
    r = login(client)
    assert r.status_code == 429
    assert "retry-after" in r.headers


def test_mfa_is_required_before_using_the_application(app_module, client):
    assert login(client).status_code == 200
    r = client.get("/api/dashboard")
    assert r.status_code == 403 and "MFA" in r.json()["detail"]
    assert client.get("/", follow_redirects=False).headers["location"] == "/mfa-setup"
    assert client.get("/mfa-setup").status_code == 200
    enroll_mfa(app_module, client)
    assert client.get("/api/dashboard").status_code == 200


def test_login_requires_totp_once_enrolled(app_module, client):
    secret = admin_session(app_module, client)
    client.post("/logout", headers=ORIGIN)
    client.cookies.clear()
    assert login(client).status_code == 401
    assert login(client, otp=app_module.totp_code(secret)).status_code == 200


def test_enrolled_totp_cannot_be_reset_without_current_code(app_module, client):
    secret = admin_session(app_module, client)
    assert client.post("/system/auth/totp/setup", headers=ORIGIN).status_code == 403
    assert client.post("/system/auth/totp/setup", json={"code": "000000"}, headers=ORIGIN).status_code in (403, 429)
    c = app_module.auth_conn()
    row = c.execute("SELECT totp_secret,totp_enabled FROM auth_users WHERE username='admin'").fetchone()
    c.close()
    assert row["totp_secret"] == secret and row["totp_enabled"] == 1
    r = client.post("/system/auth/totp/setup", json={"code": app_module.totp_code(secret)}, headers=ORIGIN)
    assert r.status_code == 200


def test_export_only_contains_the_active_tenant(app_module, client):
    admin_session(app_module, client)
    r = client.post("/system/auth/scopes", json={"company_id": "ACME", "project_id": "P1", "label": "Acme", "username": "admin"}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    tenant = client.get("/system/export", headers={"X-MASCLI-Scope": "ACME/P1"})
    assert tenant.status_code == 200
    tenant_db = app_module.TENANT_DIR / (app_module.hashlib.sha256(b"ACME/P1").hexdigest()[:24] + ".db")
    assert tenant.content == tenant_db.read_bytes()
    assert tenant.content != app_module.DB.read_bytes()
    assert "ACME" in tenant.headers["content-disposition"]


def test_untrusted_host_is_rejected_when_allowlist_configured(app_module, monkeypatch):
    monkeypatch.setenv("MASCLI_ALLOWED_HOSTS", "mascli.example.org")
    with TestClient(app_module.app, base_url=BASE_URL) as c:
        assert c.get("/health").status_code == 400
        assert c.get("/health", headers={"Host": "mascli.example.org"}).status_code == 200


INLINE_HANDLER = re.compile(r'\son[a-z]+\s*=\s*["\']', re.I)
INLINE_SCRIPT = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>', re.I)


def test_csp_forbids_inline_scripts(client):
    csp = client.get("/health").headers["content-security-policy"]
    script_src = next(d for d in csp.split(";") if d.strip().startswith("script-src"))
    assert "unsafe-inline" not in script_src and "unsafe-eval" not in script_src


@pytest.mark.parametrize("name", ["static/index.html", "static/app.js", "app.py"])
def test_no_inline_event_handlers_or_scripts(name):
    source = (ROOT / name).read_text(encoding="utf-8")
    assert INLINE_HANDLER.findall(source) == []
    assert INLINE_SCRIPT.findall(source) == []


def test_login_and_mfa_pages_load_their_scripts_without_a_session(client):
    for page, script in (("/login", "/static/login.js"), ("/mfa-setup", None)):
        if script:
            assert f'src="{script}"' in client.get(page).text
            assert client.get(script).status_code == 200
    assert client.get("/static/app.js").status_code == 401


@pytest.mark.skipif(not shutil.which("node"), reason="node no disponible")
def test_record_values_travel_as_data_not_code():
    source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    helper = "\n".join(l for l in source.splitlines() if l.startswith(("function esc(", "function act(")))
    payload = "x');globalThis.pwned=1;//\u2028\"</script>"
    script = helper + r"""
const attr = act('click', ['selectMapRecord', PAYLOAD]);
const m = attr.match(/^data-on-click="([^"]*)"$/);
if (!m) { console.error('atributo roto', attr); process.exit(1); }
const decoded = m[1].replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const calls = JSON.parse(decoded);
if (calls[0][0] !== 'selectMapRecord' || calls[0][1] !== PAYLOAD || globalThis.pwned) { console.error('fallo', calls); process.exit(1); }
""".replace("PAYLOAD", repr(payload))
    subprocess.run(["node", "-e", script], check=True)


def test_enrolled_admin_can_use_core_features(app_module, client):
    admin_session(app_module, client)
    assert client.get("/").status_code == 200
    for path in ("/api/dashboard", "/api/eventos", "/system/irsa", "/system/indicators", "/system/audit"):
        assert client.get(path).status_code == 200, path
    r = client.post("/api/eventos", json={"payload": {"Tipo_Evento": "Prueba", "Descripcion_Hecho": "x"}}, headers=ORIGIN)
    assert r.status_code == 200, r.text


def create_user(client, username, role="analista"):
    r = client.post("/system/auth/accounts", json={"username": username, "full_name": username, "password": "otra-clave-segura-456", "role": role}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    r = client.post("/system/auth/grants", json={"username": username, "company_id": "MASCLI", "project_id": "PRJ-SECHURA"}, headers=ORIGIN)
    assert r.status_code == 200, r.text


def test_admin_can_reset_another_users_mfa_but_not_their_own(app_module, client):
    admin_session(app_module, client)
    create_user(client, "ana")
    with TestClient(app_module.app, base_url=BASE_URL) as other:
        assert login(other, "ana", "otra-clave-segura-456").status_code == 200
        enroll_mfa(app_module, other)
        assert other.get("/api/dashboard").status_code == 200
        assert client.post("/system/auth/accounts/ana/reset-mfa", headers=ORIGIN).status_code == 200
        assert other.get("/api/dashboard").status_code == 401  # sesiones revocadas
    assert client.post("/system/auth/accounts/admin/reset-mfa", headers=ORIGIN).status_code == 403
    assert client.post("/system/auth/accounts/nadie/reset-mfa", headers=ORIGIN).status_code == 404
    accounts = {a["username"]: a for a in client.get("/system/auth/accounts").json()}
    assert accounts["ana"]["totp_enabled"] == 0 and accounts["admin"]["totp_enabled"] == 1


def test_non_admin_cannot_reset_mfa(app_module, client):
    admin_session(app_module, client)
    create_user(client, "luis")
    with TestClient(app_module.app, base_url=BASE_URL) as other:
        login(other, "luis", "otra-clave-segura-456")
        enroll_mfa(app_module, other)
        assert other.post("/system/auth/accounts/admin/reset-mfa", headers=ORIGIN).status_code == 403


def test_cli_reset_mfa(app_module, client, capsys):
    admin_session(app_module, client)
    import manage
    assert manage.main(["reset-mfa", "admin"]) == 0
    assert client.get("/api/dashboard").status_code == 401
    assert manage.main(["reset-mfa", "nadie"]) == 1


def test_all_runtime_state_lives_under_data_dir(app_module, client, tmp_path):
    admin_session(app_module, client)
    template = (ROOT / "data" / "irsa_config.json").read_bytes()
    cfg = client.get("/system/irsa/config").json()
    r = client.post("/system/irsa/config", json={"payload": cfg}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    data = tmp_path / "data"
    assert (data / "mascli.db").exists() and (data / "auth_global.db").exists()
    assert (data / "settings" / "irsa_config.json").exists()
    assert (ROOT / "data" / "irsa_config.json").read_bytes() == template
