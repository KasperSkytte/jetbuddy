"""SQLite storage. One file, one household. Money is stored as integer cents."""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("NESTEGG_DATA_DIR", "./data"))
DB_PATH = DATA_DIR / "nestegg.db"

# Each entry migrates the schema from version i to i+1. Never edit a released
# migration; append a new one.
MIGRATIONS = [
    """
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE members (
        id        INTEGER PRIMARY KEY,
        name      TEXT NOT NULL,
        color     INTEGER NOT NULL DEFAULT 0,
        is_shared INTEGER NOT NULL DEFAULT 0,
        sort      INTEGER NOT NULL DEFAULT 0,
        archived  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE categories (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
        sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE accounts (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL,
        kind     TEXT NOT NULL CHECK (kind IN ('main', 'savings')),
        color    INTEGER NOT NULL DEFAULT 0,
        sort     INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
    );
    -- The real balance at the end of a month, typed in by the user. Months
    -- without one are computed from the previous month plus the budget.
    CREATE TABLE account_balances (
        account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        year       INTEGER NOT NULL,
        month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        cents      INTEGER NOT NULL,
        PRIMARY KEY (account_id, year, month)
    );
    CREATE TABLE items (
        id          INTEGER PRIMARY KEY,
        member_id   INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
        name        TEXT NOT NULL,
        category_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
        account_id  INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
        fixed       INTEGER NOT NULL DEFAULT 0,
        note        TEXT NOT NULL DEFAULT '',
        sort        INTEGER NOT NULL DEFAULT 0
    );
    -- Which years an item is part of the budget. An item also shows in any
    -- year it has amounts in, so this only matters for years with none yet.
    CREATE TABLE item_years (
        item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        year    INTEGER NOT NULL,
        PRIMARY KEY (item_id, year)
    );
    CREATE TABLE amounts (
        item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        year    INTEGER NOT NULL,
        month   INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        cents   INTEGER NOT NULL,
        PRIMARY KEY (item_id, year, month)
    );
    CREATE INDEX amounts_year ON amounts (year);
    CREATE INDEX item_years_year ON item_years (year);
    """,
]


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    # Autocommit mode: writes that need atomicity use transaction() below.
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, script in enumerate(MIGRATIONS[version:], start=version):
        conn.executescript(f"BEGIN; {script}\nPRAGMA user_version = {i + 1}; COMMIT;")


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Commit on success, roll back on any error."""
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def to_cents(value: float | int | None) -> int | None:
    if value is None:
        return None
    return int(round(float(value) * 100))


def from_cents(cents: int | None) -> float | None:
    if cents is None:
        return None
    return cents / 100
