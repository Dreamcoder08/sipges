import importlib, sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ADMIN_PASSWORD = "clave-de-prueba-segura-123"
BASE_URL = "https://testserver"
ORIGIN = {"Origin": BASE_URL}


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    """Carga app.py con almacenamiento aislado en un directorio temporal."""
    monkeypatch.setenv("MASCLI_DB_PATH", str(tmp_path / "mascli.db"))
    monkeypatch.setenv("MASCLI_AUTH_DB_PATH", str(tmp_path / "auth.db"))
    monkeypatch.setenv("MASCLI_TENANT_DIR", str(tmp_path / "tenants"))
    monkeypatch.setenv("MASCLI_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("MASCLI_ADMIN_USERNAME", "admin")
    monkeypatch.setenv("MASCLI_ADMIN_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.delenv("MASCLI_COOKIE_SECURE", raising=False)
    monkeypatch.delenv("MASCLI_REQUIRE_MFA", raising=False)
    monkeypatch.delenv("MASCLI_ALLOWED_HOSTS", raising=False)
    if "app" in sys.modules:
        module = importlib.reload(sys.modules["app"])
    else:
        module = importlib.import_module("app")
    return module


@pytest.fixture
def client(app_module):
    with TestClient(app_module.app, base_url=BASE_URL) as c:
        yield c
