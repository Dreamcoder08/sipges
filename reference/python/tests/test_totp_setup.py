"""Exercise MFA enrollment through real login, middleware and endpoints."""

from urllib.parse import parse_qs, urlsplit

import pytest

from conftest import DEFAULT, PASSWORD, login


SETUP = "/system/auth/totp/setup"
ENABLE = "/system/auth/totp/enable"
SCOPE_HEADERS = {"X-SIPGES-Scope": DEFAULT}


def enrollment_state(module, username="synthetic-admin"):
    db = module.auth_conn()
    try:
        row = db.execute(
            "SELECT totp_secret,totp_enabled FROM auth_users WHERE username=?",
            (username,),
        ).fetchone()
        return tuple(row)
    finally:
        db.close()


def test_enabled_mfa_cannot_be_reset_by_retained_session(isolated_app):
    module, client = isolated_app
    login(client)
    setup = client.post(SETUP, headers=SCOPE_HEADERS)
    assert setup.status_code == 200
    secret = setup.json()["secret"]
    enabled = client.post(ENABLE, headers=SCOPE_HEADERS,
                          json={"code": module.totp_code(secret)})
    assert enabled.status_code == 200
    assert enabled.json() == {"ok": True, "totp_enabled": True}
    assert enrollment_state(module) == (secret, 1)

    # Enable retains this session: repeated setup must not disable MFA.
    for _ in range(2):
        rejected = client.post(SETUP, headers=SCOPE_HEADERS)
        assert rejected.status_code == 409
        assert set(rejected.json()) == {"detail"}
        assert secret not in rejected.text
        assert enrollment_state(module) == (secret, 1)

    client.cookies.clear()
    credentials = {"username": "synthetic-admin", "password": PASSWORD}
    assert client.post("/login", data=credentials).status_code == 401
    credentials["otp"] = module.totp_code(secret)
    assert client.post("/login", data=credentials).status_code == 200


def test_unenrolled_setup_can_be_retried(isolated_app):
    module, client = isolated_app
    login(client)
    secrets = []
    for _ in range(2):
        response = client.post(SETUP, headers=SCOPE_HEADERS)
        assert response.status_code == 200
        payload = response.json()
        assert set(payload) == {"secret", "otpauth_uri", "instruction"}
        secret = payload["secret"]
        assert len(secret) == 32
        assert set(secret) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        uri = urlsplit(payload["otpauth_uri"])
        assert uri.scheme == "otpauth" and uri.netloc == "totp"
        assert parse_qs(uri.query) == {
            "secret": [secret], "issuer": ["SIPGES"], "algorithm": ["SHA1"],
            "digits": ["6"], "period": ["30"],
        }
        assert payload["instruction"]
        assert enrollment_state(module) == (secret, 0)
        secrets.append(secret)
    assert secrets[0] != secrets[1]


@pytest.mark.parametrize("username,status", [
    (None, 401),
    ("synthetic-reader", 403),
    ("synthetic-coordinator", 403),
    ("synthetic-analyst", 200),
])
def test_setup_preserves_existing_access_policy(isolated_app, username, status):
    module, client = isolated_app
    before = enrollment_state(module, username) if username else None
    if username:
        login(client, username)
    response = client.post(SETUP, headers=SCOPE_HEADERS)
    assert response.status_code == status
    if status != 200:
        assert set(response.json()) == {"detail"}
        if username:
            assert enrollment_state(module, username) == before
    else:
        assert enrollment_state(module, username) == (response.json()["secret"], 0)
