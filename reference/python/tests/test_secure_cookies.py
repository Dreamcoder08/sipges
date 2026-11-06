"""Cookie policy and transport regressions using only synthetic resources."""

from http.cookies import SimpleCookie

import pytest

from conftest import PASSWORD, TENANT_A, TENANT_B, login


def assert_cookie(response, name, secure):
    headers = response.headers.get_list("set-cookie")
    assert len(headers) == 1
    parsed = SimpleCookie()
    parsed.load(headers[0])
    assert list(parsed) == [name]
    cookie = parsed[name]
    assert bool(cookie["secure"]) is secure
    assert cookie["httponly"]
    assert cookie["samesite"].lower() == "strict"
    assert cookie["path"] == "/"
    assert cookie["max-age"] == str(8 * 3600)
    assert not cookie["domain"]  # host-only, not shared with subdomains


@pytest.mark.parametrize("isolated_app,secure", [
    ({"cookie_secure": None, "base_url": "https://testserver"}, True),
    ({"cookie_secure": "1", "base_url": "https://testserver"}, True),
    ({"cookie_secure": "0", "base_url": "http://testserver"}, False),
], indirect=["isolated_app"])
def test_both_cookies_and_authenticated_scope_followup(isolated_app, secure, monkeypatch):
    _, client = isolated_app
    # Configuration is startup-static, not re-read during cookie issuance.
    monkeypatch.setenv("SIPGES_COOKIE_SECURE", "0" if secure else "1")
    response = client.post("/login", data={
        "username": "synthetic-admin", "password": PASSWORD,
    })
    assert response.status_code == 200
    assert_cookie(response, "sipges_session", secure)
    assert client.get("/system/auth/me").json()["username"] == "synthetic-admin"
    for scope in (TENANT_A, TENANT_B):
        response = client.post("/select-project", data={"scope": scope}, follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"] == "/"
        assert_cookie(response, "sipges_scope", secure)
        # No X-SIPGES-Scope header: middleware must use the transported cookie.
        response = client.get("/system/auth/current-scope")
        assert response.status_code == 200
        assert response.json()["scope"] == scope


@pytest.mark.parametrize("isolated_app", [
    {"cookie_secure": None, "base_url": "https://testserver"},
    {"cookie_secure": "1", "base_url": "https://testserver"},
], indirect=True)
def test_secure_cookies_not_transported_over_http(isolated_app):
    _, client = isolated_app
    login(client)
    assert client.post("/select-project", data={"scope": TENANT_A},
                       follow_redirects=False).status_code == 303
    request = client.build_request("GET", "http://testserver/system/auth/current-scope")
    assert "cookie" not in request.headers  # neither session nor scope cookie
    assert client.send(request).status_code == 401
    response = client.post("http://testserver/select-project", data={"scope": TENANT_A},
                           follow_redirects=False)
    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    assert client.get("/system/auth/current-scope").json()["scope"] == TENANT_A


@pytest.mark.parametrize("isolated_app", [
    {"cookie_secure": None, "base_url": "https://testserver"},
    {"cookie_secure": "0"},
], indirect=True)
def test_unauthorized_selection_never_sets_cookie(isolated_app):
    _, client = isolated_app
    response = client.post("/select-project", data={"scope": TENANT_A}, follow_redirects=False)
    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    login(client)
    response = client.post("/select-project", data={"scope": "UNGRANTED/PROJECT"},
                           follow_redirects=False)
    assert response.status_code == 403
    assert "set-cookie" not in response.headers
    assert "sipges_scope" not in client.cookies


@pytest.mark.parametrize("value", ["", " ", "\t", "\n", "true", "false", "yes", "01", "2", " 1", "0 "])
def test_invalid_config_fails_before_resource_initialization(
    isolated_import, tmp_path, monkeypatch, value,
):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid cookie policy reached resource initialization")

    monkeypatch.setattr("fastapi.FastAPI", forbidden)
    monkeypatch.setattr("storage_sqlite.connect_sqlite", forbidden)
    with pytest.raises(ValueError, match="SIPGES_COOKIE_SECURE must be unset or exactly '0' or '1'"):
        isolated_import(value)
    assert list(tmp_path.iterdir()) == []
