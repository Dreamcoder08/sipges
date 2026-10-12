"""Real app/middleware regression tests; no operational data is opened."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


DEFAULT = "MASCLI/PRJ-SECHURA"
TENANT_A = "SYNTHETIC-A/PROJECT-A"
TENANT_B = "SYNTHETIC-B/PROJECT-B"
MISSING = "SYNTHETIC-MISSING/PROJECT-MISSING"
MARKERS = {
    DEFAULT: b"SYNTHETIC_DEFAULT_EXPORT_ONLY",
    TENANT_A: b"SYNTHETIC_TENANT_A_EXPORT_ONLY",
    TENANT_B: b"SYNTHETIC_TENANT_B_EXPORT_ONLY",
}
PASSWORD = "synthetic-test-password-only"


def tenant_path(module, scope):
    digest = hashlib.sha256(scope.encode()).hexdigest()[:24]
    return module.TENANT_DIR / (digest + ".db")


@pytest.fixture
def isolated_app(tmp_path, monkeypatch):
    # All environment-derived resource paths are redirected BEFORE import.
    for name, path in {
        "MASCLI_DB_PATH": tmp_path / "default.db",
        "MASCLI_AUTH_DB_PATH": tmp_path / "auth.db",
        "MASCLI_UPLOAD_DIR": tmp_path / "uploads",
        "MASCLI_TENANT_DIR": tmp_path / "tenants",
    }.items():
        monkeypatch.setenv(name, str(path))
    monkeypatch.setenv("MASCLI_ADMIN_USERNAME", "synthetic-admin")
    monkeypatch.setenv("MASCLI_ADMIN_PASSWORD", PASSWORD)
    monkeypatch.setenv("MASCLI_COOKIE_SECURE", "0")

    spec = importlib.util.spec_from_file_location(
        "isolated_export_app", Path(__file__).resolve().parents[1] / "app.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    seed = tmp_path / "synthetic-seed.json"
    seed.write_text(json.dumps({"Eventos": [{
        "ID_Evento": "SYNTHETIC-DEFAULT",
        "marker": MARKERS[DEFAULT].decode(),
    }]}), encoding="utf-8")
    # Startup must never read the original SEED.
    module.SEED = seed
    # Defense in depth for non-export config paths: never use repository data.
    for name in ("IRSA_CONFIG", "INDICATOR_CONFIG", "MODEL_STATUS",
                 "CANONICAL_ENTITIES", "PROJECT_COORDINATES"):
        monkeypatch.setattr(module, name, tmp_path / (name.lower() + ".json"))

    with TestClient(module.app) as client:
        module.TENANT_DIR.mkdir()
        for scope in (TENANT_A, TENANT_B):
            with sqlite3.connect(tenant_path(module, scope)) as db:
                db.execute("CREATE TABLE synthetic_marker (value TEXT NOT NULL)")
                db.execute("INSERT INTO synthetic_marker VALUES (?)",
                           (MARKERS[scope].decode(),))
        with module.auth_conn() as auth:
            for scope in (TENANT_A, TENANT_B, MISSING):
                company, project = scope.split("/", 1)
                auth.execute("INSERT INTO tenant_projects VALUES (?,?,?)",
                             (company, project, "Synthetic project"))
                auth.execute("INSERT INTO access_grants VALUES (?,?,?)",
                             ("synthetic-admin", company, project))
            auth.execute(
                "INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at) "
                "VALUES (?,?,?,?,?,?)",
                ("synthetic-reader", "Synthetic reader", module.hash_password(PASSWORD),
                 "consulta", 1, module.now()),
            )
            auth.execute("INSERT INTO access_grants VALUES (?,?,?)",
                         ("synthetic-reader", "MASCLI", "PRJ-SECHURA"))
            # A sole-grant admin exercises middleware's implicit default scope.
            auth.execute(
                "INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at) "
                "VALUES (?,?,?,?,?,?)",
                ("synthetic-default-admin", "Synthetic default admin",
                 module.hash_password(PASSWORD), "admin", 1, module.now()),
            )
            auth.execute("INSERT INTO access_grants VALUES (?,?,?)",
                         ("synthetic-default-admin", "MASCLI", "PRJ-SECHURA"))
        yield module, client


def login(client, username="synthetic-admin"):
    response = client.post("/login", data={"username": username, "password": PASSWORD})
    assert response.status_code == 200


def assert_download(response, scope):
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert 'filename="mascli.db"' in response.headers["content-disposition"]
    assert response.content.startswith(b"SQLite format 3\x00")
    assert MARKERS[scope] in response.content
    for other_scope, marker in MARKERS.items():
        if other_scope != scope:
            assert marker not in response.content


def test_default_scope_export(isolated_app):
    _, client = isolated_app
    login(client, "synthetic-default-admin")
    assert_download(client.get("/system/export"), DEFAULT)


@pytest.mark.parametrize("scope", [TENANT_A, TENANT_B])
def test_tenant_export_contains_only_authorized_marker(isolated_app, scope):
    _, client = isolated_app
    login(client)
    assert_download(client.get("/system/export", headers={"X-MASCLI-Scope": scope}), scope)


def test_sequential_scope_switching(isolated_app):
    _, client = isolated_app
    login(client)
    for scope in (TENANT_A, TENANT_B, DEFAULT, TENANT_A):
        assert_download(client.get("/system/export", headers={"X-MASCLI-Scope": scope}), scope)


@pytest.mark.parametrize("user,scope,status", [
    (None, DEFAULT, 401),
    ("synthetic-reader", DEFAULT, 403),
    ("synthetic-admin", "UNGRANTED/PROJECT", 403),
    ("synthetic-admin", MISSING, 503),
    ("synthetic-admin", None, 403),
])
def test_export_denied(isolated_app, user, scope, status):
    module, client = isolated_app
    if user:
        login(client, user)
    headers = {"X-MASCLI-Scope": scope} if scope else {}
    response = client.get("/system/export", headers=headers)
    assert response.status_code == status
    assert all(marker not in response.content for marker in MARKERS.values())
    assert "content-disposition" not in response.headers
    assert not tenant_path(module, MISSING).exists()


def test_endpoint_without_scope_fails_closed(isolated_app):
    module, _ = isolated_app
    token = module.SCOPE_DB.set(None)
    try:
        with pytest.raises(HTTPException) as error:
            module.export_db()
        assert error.value.status_code == 403
    finally:
        module.SCOPE_DB.reset(token)
