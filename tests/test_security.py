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


INLINE_HANDLER = re.compile(r'\son[a-z]+="[^"]*\$\{[^"]*"')


def test_frontend_handlers_do_not_interpolate_html_escaped_strings():
    source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    offenders = [m.group(0) for m in INLINE_HANDLER.finditer(source) if "'${" in m.group(0)]
    assert offenders == []


@pytest.mark.skipif(not shutil.which("node"), reason="node no disponible")
def test_jsq_neutralises_quote_breakout():
    source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    helpers = "\n".join(l for l in source.splitlines() if l.startswith(("function esc(", "function jsq(")))
    payload = "x');globalThis.pwned=1;// \"</script>"
    script = helpers + r"""
const attr = jsq(PAYLOAD);
const decoded = attr.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
let got; const pick = v => { got = v; };
new Function('pick', 'pick(' + decoded + ')')(pick);
if (got !== PAYLOAD || globalThis.pwned) { console.error('fallo', got); process.exit(1); }
""".replace("PAYLOAD", repr(payload).replace("\\u2028", "\\u2028"))
    subprocess.run(["node", "-e", script], check=True)


def test_enrolled_admin_can_use_core_features(app_module, client):
    admin_session(app_module, client)
    assert client.get("/").status_code == 200
    for path in ("/api/dashboard", "/api/eventos", "/system/irsa", "/system/indicators", "/system/audit"):
        assert client.get(path).status_code == 200, path
    r = client.post("/api/eventos", json={"payload": {"Tipo_Evento": "Prueba", "Descripcion_Hecho": "x"}}, headers=ORIGIN)
    assert r.status_code == 200, r.text
