"""Optional single shared password.

Nestegg is meant for a home network, so by default anyone who can reach it can
use it. Set NESTEGG_PASSWORD to require a login; the session is a signed
cookie, so nothing about it is stored server side.
"""

import hashlib
import hmac
import os
import secrets
import time

from . import db

COOKIE = "nestegg_session"
SESSION_SECONDS = 365 * 24 * 3600


def password() -> str:
    return os.environ.get("NESTEGG_PASSWORD", "")


def _secret() -> bytes:
    env = os.environ.get("NESTEGG_SECRET")
    if env:
        return env.encode()
    path = db.DATA_DIR / "secret.key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32))
        path.chmod(0o600)
    return path.read_text().strip().encode()


def _sign(payload: str) -> str:
    # The password is part of the key, so changing it logs everyone out.
    key = _secret() + b"|" + password().encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    expires = str(int(time.time()) + SESSION_SECONDS)
    return f"{expires}.{_sign(expires)}"


def valid_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires, sig = token.split(".", 1)
    if not expires.isdigit() or int(expires) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(expires))


def check_password(attempt: str) -> bool:
    return bool(password()) and hmac.compare_digest(attempt.encode(), password().encode())
