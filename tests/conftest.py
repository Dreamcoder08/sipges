"""Shared synthetic app fixture; operational data is never opened."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest
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
        "isolated_test_app", Path(__file__).resolve().parents[1] / "app.py"
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
            for username, role in (
                ("synthetic-reader", "consulta"),
                ("synthetic-coordinator", "coordinador"),
                ("synthetic-analyst", "analista"),
                ("synthetic-default-admin", "admin"),
            ):
                auth.execute(
                    "INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (username, "Synthetic user", module.hash_password(PASSWORD),
                     role, 1, module.now()),
                )
                auth.execute("INSERT INTO access_grants VALUES (?,?,?)",
                             (username, "MASCLI", "PRJ-SECHURA"))
        yield module, client


def login(client, username="synthetic-admin"):
    response = client.post("/login", data={"username": username, "password": PASSWORD})
    assert response.status_code == 200
