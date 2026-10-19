"""Logins: one per budget, shared by everyone in the household.

Passwords are hashed with scrypt. The session is a signed cookie naming the
budget, so nothing about it is stored server side. Changing a budget's
password logs everyone out of it.
"""

import hashlib
import hmac
import os
import secrets
import threading
import time

from . import db
from . import env as getenv

COOKIE = "sparegrisen_session"
SESSION_SECONDS = 365 * 24 * 3600
MIN_PASSWORD = 8

# scrypt cost; about 50 ms and 16 MB per hash.
_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        attempt = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(digest))
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(attempt.hex(), digest)


_DUMMY = hash_password(secrets.token_hex(8))


def burn_time(password: str) -> None:
    """Take as long as a real check, so unknown logins can't be told apart."""
    verify_password(password, _DUMMY)


def _secret() -> bytes:
    env = getenv("SECRET")
    if env:
        return env.encode()
    path = db.DATA_DIR / "secret.key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32))
        path.chmod(0o600)
    return path.read_text().strip().encode()


def _sign(budget_id: int, expires: int, password_hash: str) -> str:
    # Part of the password hash is signed along, so a new password ends old sessions.
    payload = f"{budget_id}.{expires}.{password_hash[-16:]}"
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(budget_id: int, password_hash: str) -> str:
    expires = int(time.time()) + SESSION_SECONDS
    return f"{budget_id}.{expires}.{_sign(budget_id, expires, password_hash)}"


def budget_from_token(token: str | None) -> int | None:
    """The budget a session cookie belongs to, or None if it is not valid."""
    try:
        budget_id, expires, sig = (token or "").split(".")
        budget_id, expires = int(budget_id), int(expires)
    except ValueError:
        return None
    if expires < time.time():
        return None
    conn = db.open_server()
    try:
        row = conn.execute("SELECT password_hash FROM budgets WHERE id = ?", (budget_id,)).fetchone()
    finally:
        conn.close()
    if not row or not hmac.compare_digest(sig, _sign(budget_id, expires, row[0])):
        return None
    return budget_id


# Failed logins per client address, to slow down guessing.
_failures: dict[str, list[float]] = {}
_failures_lock = threading.Lock()
MAX_FAILURES = 10
WINDOW = 15 * 60


def too_many_failures(client: str) -> bool:
    with _failures_lock:
        recent = [t for t in _failures.get(client, []) if t > time.time() - WINDOW]
        _failures[client] = recent
        return len(recent) >= MAX_FAILURES


def record_failure(client: str) -> None:
    with _failures_lock:
        _failures.setdefault(client, []).append(time.time())


def allow_new_budgets() -> bool:
    return getenv("ALLOW_NEW_BUDGETS", "true").lower() not in ("0", "false", "no")
