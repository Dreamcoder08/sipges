"""Real app/middleware regression tests; no operational data is opened."""

import pytest
from fastapi import HTTPException

from conftest import DEFAULT, MARKERS, MISSING, TENANT_A, TENANT_B, login, tenant_path


def assert_download(response, scope):
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert 'filename="sipges.db"' in response.headers["content-disposition"]
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
    assert_download(client.get("/system/export", headers={"X-SIPGES-Scope": scope}), scope)


def test_sequential_scope_switching(isolated_app):
    _, client = isolated_app
    login(client)
    for scope in (TENANT_A, TENANT_B, DEFAULT, TENANT_A):
        assert_download(client.get("/system/export", headers={"X-SIPGES-Scope": scope}), scope)


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
    headers = {"X-SIPGES-Scope": scope} if scope else {}
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
