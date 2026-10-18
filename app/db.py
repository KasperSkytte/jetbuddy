"""SQLite storage. Money is stored as integer cents.

One server can hold several budgets (households), each with its own login.
A small server database lists the budgets; every budget has a folder of its
own with its database and its bank key, so budgets never see each other.

    data/jetbuddy.db                  the budgets and their logins
    data/budgets/<id>/budget.db       one budget
    data/budgets/<id>/enablebanking.* its bank connection key, if any
"""

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("JETBUDDY_DATA_DIR", "./data"))

# Each entry migrates the schema from version i to i+1. Never edit a released
# migration; append a new one.
SERVER_MIGRATIONS = [
    """
    CREATE TABLE budgets (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        login         TEXT NOT NULL UNIQUE,  -- lower case
        password_hash TEXT NOT NULL,
        created       INTEGER NOT NULL
    );
    """,
]

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
    # Bank connections through Enable Banking.
    """
    -- Where a balance came from: typed in by hand, or computed from the bank.
    ALTER TABLE account_balances ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
    -- A bank login waiting for the user to come back from the bank.
    CREATE TABLE bank_pending (
        state         TEXT PRIMARY KEY,
        aspsp_name    TEXT NOT NULL,
        aspsp_country TEXT NOT NULL,
        psu_headers   TEXT NOT NULL DEFAULT '[]',
        created       INTEGER NOT NULL
    );
    CREATE TABLE bank_sessions (
        id            TEXT PRIMARY KEY,  -- Enable Banking's session_id
        aspsp_name    TEXT NOT NULL,
        aspsp_country TEXT NOT NULL,
        valid_until   TEXT NOT NULL,
        psu_headers   TEXT NOT NULL DEFAULT '[]',  -- PSU headers the bank requires
        status        TEXT NOT NULL DEFAULT 'active',  -- active | expired
        created       INTEGER NOT NULL,
        last_sync     INTEGER,
        last_error    TEXT
    );
    CREATE TABLE bank_accounts (
        id            INTEGER PRIMARY KEY,
        session_id    TEXT REFERENCES bank_sessions (id) ON DELETE SET NULL,
        uid           TEXT NOT NULL,     -- changes with every new bank login
        ident         TEXT NOT NULL,     -- stable: IBAN or identification hash
        name          TEXT NOT NULL DEFAULT '',
        iban          TEXT,
        currency      TEXT,
        account_id    INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
        track         INTEGER NOT NULL DEFAULT 1,  -- use its transactions in the budget
        balance_cents INTEGER,
        balance_date  TEXT,
        history_from  TEXT,              -- earliest date transactions were fetched from
        synced_to     TEXT               -- latest booking date fetched
    );
    CREATE UNIQUE INDEX bank_accounts_ident ON bank_accounts (ident);
    CREATE TABLE bank_transactions (
        id              INTEGER PRIMARY KEY,
        bank_account_id INTEGER NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
        ext_id          TEXT NOT NULL,
        booking_date    TEXT NOT NULL,
        year            INTEGER NOT NULL,
        month           INTEGER NOT NULL,
        cents           INTEGER NOT NULL,  -- positive in, negative out
        counterparty    TEXT NOT NULL DEFAULT '',
        text            TEXT NOT NULL DEFAULT '',
        item_id         INTEGER REFERENCES items (id) ON DELETE SET NULL,
        ignored         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (bank_account_id, ext_id)
    );
    CREATE INDEX bank_transactions_month ON bank_transactions (year, month);
    CREATE INDEX bank_transactions_item ON bank_transactions (item_id);
    -- "Transactions whose text contains NETFLIX belong to the Netflix item."
    CREATE TABLE bank_rules (
        id      INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL,
        item_id INTEGER REFERENCES items (id) ON DELETE CASCADE,
        ignore  INTEGER NOT NULL DEFAULT 0
    );
    """,
    # Set once someone picks a bank account's link by hand ("Nothing"
    # included), so automatic linking leaves it alone from then on.
    """
    ALTER TABLE bank_accounts ADD COLUMN link_chosen INTEGER NOT NULL DEFAULT 0;
    """,
    # Spreadsheet cells an import couldn't read as amounts. They are kept, so
    # the gap shows until someone enters the amount or says to ignore it,
    # instead of silently making the totals wrong.
    """
    CREATE TABLE unreadable (
        item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        year    INTEGER NOT NULL,
        month   INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        raw     TEXT NOT NULL,
        PRIMARY KEY (item_id, year, month)
    );
    """,
]


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Autocommit mode: writes that need atomicity use transaction() below.
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def migrate(conn: sqlite3.Connection, migrations: list[str] = MIGRATIONS) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, script in enumerate(migrations[version:], start=version):
        conn.executescript(f"BEGIN; {script}\nPRAGMA user_version = {i + 1}; COMMIT;")


def budget_dir(budget_id: int) -> Path:
    return DATA_DIR / "budgets" / str(budget_id)


def open_server() -> sqlite3.Connection:
    conn = connect(DATA_DIR / "jetbuddy.db")
    migrate(conn, SERVER_MIGRATIONS)
    return conn


def open_budget(budget_id: int) -> sqlite3.Connection:
    conn = connect(budget_dir(budget_id) / "budget.db")
    migrate(conn)
    return conn


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


# What the budget does with decimals ("decimals" setting): keep them, round
# to whole units (to the nearest, always up or always down), or accept whole
# numbers only, where amounts are typed or imported.
DECIMAL_MODES = ("keep", "nearest", "up", "down", "only")


def decimals_mode(conn: sqlite3.Connection) -> str:
    r = conn.execute("SELECT value FROM settings WHERE key = 'decimals'").fetchone()
    mode = json.loads(r[0]) if r else "keep"
    return mode if mode in DECIMAL_MODES else "keep"


def round_cents(cents: int | None, mode: str) -> int | None:
    """cents in whole units as mode says. Up and down are away from and
    towards zero, so a refund of -12.30 rounds up to -13 as 12.30 rounds up
    to 13, and rounding down is dropping the decimals. 'keep' and 'only'
    change nothing (with 'only', amounts with decimals are refused instead)."""
    if cents is None or mode not in ("nearest", "up", "down"):
        return cents
    whole, rest = divmod(abs(cents), 100)
    if rest and (mode == "up" or (mode == "nearest" and rest >= 50)):
        whole += 1
    return (-1 if cents < 0 else 1) * whole * 100
