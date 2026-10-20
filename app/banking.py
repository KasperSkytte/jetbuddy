"""Bank sync through Enable Banking (https://enablebanking.com).

Enable Banking is a licensed PSD2 provider: it logs in to the bank on the
user's behalf (with the bank's own login, e.g. MitID) and hands back read-only
access to balances and transactions. Its free "restricted" mode is limited to
accounts the application owner links in the Enable Banking Control Panel,
which is exactly a family using its own bank accounts.

What a sync does, per connected bank account:
  - stores the current balance;
  - stores booked transactions (pending ones change ids when they book);
  - sorts new transactions onto budget items using the saved rules;
  - for an account linked to one of the accounts in Sparegrisen, works out the real
    balance at the end of every completed month it has transactions for, and
    saves those as the account's actual balances.
"""

import hashlib
import json
import re
import secrets
import sqlite3
import stat
import threading
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import httpx
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from cryptography.x509.oid import NameOID

from . import db
from . import env as getenv

API_URL = getenv("EB_API_URL", "https://api.enablebanking.com")
SYNC_HOURS = float(getenv("BANK_SYNC_HOURS", "6"))
# How long to ask the bank for access. Banks cap it (often at 90 or 180 days);
# the shorter of the two is used.
CONSENT_DAYS = 180
# Re-fetch this many days before the last sync, for transactions that book late.
OVERLAP_DAYS = 10
# Tests swap this for an httpx.MockTransport.
TRANSPORT: httpx.BaseTransport | None = None

PSU_HEADERS = [
    "Psu-Ip-Address", "Psu-User-Agent", "Psu-Referer", "Psu-Accept",
    "Psu-Accept-Charset", "Psu-Accept-Encoding", "Psu-Accept-Language",
]
# Preferred balance types, most useful first: booked closing balance, then
# interim balances, then whatever else the bank offers.
BALANCE_TYPES = ["CLBD", "ITBD", "XPCD", "CLAV", "ITAV", "OPBD", "OPAV", "PRCD", "INFO", "OTHR", "VALU", "FWAV"]
_sync_lock = threading.Lock()  # one sync at a time (manual and scheduled)
SESSION_GONE = {"EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST", "UNAUTHORIZED_ACCESS"}


class ConfigError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class BankError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


# --------------------------------------------------------------------------
# Configuration: the Enable Banking application id and its private key, kept
# in the budget's own folder (never in backups).
#
# Enable Banking checks every request against a public certificate registered
# with the application. Sparegrisen can make the key pair itself: the private key
# never leaves the server, and the user pastes the certificate into Enable
# Banking's form.


def _files(bdir: Path) -> dict[str, Path]:
    return {
        "config": bdir / "enablebanking.json",
        "key": bdir / "enablebanking.pem",
        "pending_key": bdir / "enablebanking-new.pem",
        "pending_cert": bdir / "enablebanking-new.crt",
        "cert": bdir / "enablebanking.crt",
    }


def get_config(bdir: Path) -> tuple[str, str] | None:
    f = _files(bdir)
    if not f["config"].exists() or not f["key"].exists():
        return None
    app_id = json.loads(f["config"].read_text()).get("app_id")
    return (app_id, f["key"].read_text()) if app_id else None


def _write_secret(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def new_certificate(bdir: Path) -> str:
    """Make a key pair for a new Enable Banking application and return the
    public certificate to paste into their form. Asking again returns the same
    one until it is used, so reloading the page doesn't invalidate it."""
    f = _files(bdir)
    if f["pending_key"].exists() and f["pending_cert"].exists():
        return f["pending_cert"].read_text()
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Sparegrisen")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )
    _write_secret(
        f["pending_key"],
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
    )
    pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    f["pending_cert"].write_text(pem)
    return pem


def pending_certificate(bdir: Path) -> str | None:
    f = _files(bdir)
    return f["pending_cert"].read_text() if f["pending_cert"].exists() else None


def current_certificate(bdir: Path) -> str | None:
    f = _files(bdir)
    return f["cert"].read_text() if f["cert"].exists() else None


def save_config(bdir: Path, app_id: str, private_key: str | None = None) -> None:
    """Use this application id, with an uploaded private key or else the key
    pair made by new_certificate()."""
    f = _files(bdir)
    cert = None
    if private_key is None:
        if not f["pending_key"].exists():
            raise ConfigError("NO_CERTIFICATE", "make the certificate first")
        private_key = f["pending_key"].read_text()
        cert = f["pending_cert"].read_text()
    try:
        load_pem_private_key(private_key.encode(), password=None)
    except (ValueError, TypeError) as e:
        raise ConfigError("INVALID_KEY", "not a valid private key (.pem or .key file)") from e
    app_id = app_id.strip()
    if not re.fullmatch(r"[0-9a-fA-F-]{20,64}", app_id):
        raise ConfigError("INVALID_APP_ID", "that doesn't look like an application ID (it looks like aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)")
    _write_secret(f["key"], private_key.strip() + "\n")
    f["config"].write_text(json.dumps({"app_id": app_id}))
    if cert:
        f["cert"].write_text(cert)
        f["pending_key"].unlink(missing_ok=True)
        f["pending_cert"].unlink(missing_ok=True)
    else:
        f["cert"].unlink(missing_ok=True)


def delete_config(bdir: Path) -> None:
    for path in _files(bdir).values():
        path.unlink(missing_ok=True)


def test_connection(bdir: Path, country: str = "DK") -> tuple[bool, str]:
    """Ask Enable Banking for its list of banks: works only if it accepts the key."""
    try:
        banks = client(bdir).aspsps(country)
        return True, f"{len(banks)} banks"
    except BankError as e:
        return False, str(e)


# --------------------------------------------------------------------------
# API client


class EnableBanking:
    def __init__(self, app_id: str, private_key: str):
        self.app_id = app_id
        self.key = private_key
        self.http = httpx.Client(base_url=API_URL, timeout=60, transport=TRANSPORT)

    def _token(self) -> str:
        now = int(time.time())
        return jwt.encode(
            {"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now + 3600},
            self.key,
            algorithm="RS256",
            headers={"kid": self.app_id},
        )

    def request(self, method: str, path: str, *, psu: dict | None = None, **kwargs) -> dict:
        headers = {"Authorization": f"Bearer {self._token()}", **(psu or {})}
        try:
            r = self.http.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as e:
            raise BankError(0, "NETWORK", f"could not reach Enable Banking: {e}") from e
        if r.status_code >= 400:
            try:
                body = r.json()
            except ValueError:
                body = {}
            detail = body.get("detail")
            message = body.get("message") or r.text[:200] or r.reason_phrase
            if detail and isinstance(detail, str):
                message = f"{message}: {detail}"
            raise BankError(r.status_code, str(body.get("error") or r.status_code), message)
        return r.json() if r.content else {}

    def aspsps(self, country: str) -> list[dict]:
        return self.request("GET", "/aspsps", params={"country": country, "psu_type": "personal"})["aspsps"]

    def start_auth(self, body: dict) -> dict:
        return self.request("POST", "/auth", json=body)

    def create_session(self, code: str) -> dict:
        return self.request("POST", "/sessions", json={"code": code})

    def get_session(self, session_id: str) -> dict:
        return self.request("GET", f"/sessions/{session_id}")

    def delete_session(self, session_id: str) -> None:
        self.request("DELETE", f"/sessions/{session_id}")

    def balances(self, uid: str, psu: dict | None) -> list[dict]:
        return self.request("GET", f"/accounts/{uid}/balances", psu=psu)["balances"]

    def transactions(self, uid: str, psu: dict | None, date_from: str | None, strategy: str) -> list[dict]:
        params: dict = {"strategy": strategy}
        if date_from:
            params["date_from"] = date_from
        out = []
        while True:
            page = self.request("GET", f"/accounts/{uid}/transactions", psu=psu, params=params)
            out.extend(page.get("transactions") or [])
            key = page.get("continuation_key")
            if not key:
                return out
            params = {**params, "continuation_key": key}


def client(bdir: Path) -> EnableBanking:
    config = get_config(bdir)
    if not config:
        raise BankError(400, "NOT_CONFIGURED", "Enable Banking is not set up")
    return EnableBanking(*config)


# --------------------------------------------------------------------------
# Parsing what the bank sends


def _cents(amount) -> int:
    try:
        return int((Decimal(str(amount)) * 100).quantize(Decimal(1)))
    except (InvalidOperation, ValueError):
        return 0


def transaction_cents(tx: dict) -> int:
    """Positive for money in, negative for money out."""
    cents = _cents((tx.get("transaction_amount") or {}).get("amount", "0"))
    indicator = tx.get("credit_debit_indicator")
    if indicator == "DBIT":
        return -abs(cents)
    if indicator == "CRDT":
        return abs(cents)
    return cents


def transaction_texts(tx: dict) -> tuple[str, str]:
    """(counterparty, description) in the form people recognise from the net bank."""
    out = (tx.get("credit_debit_indicator") or "DBIT") == "DBIT"
    party = (tx.get("creditor") if out else tx.get("debtor")) or {}
    counterparty = (party.get("name") or "").strip()
    remittance = tx.get("remittance_information") or []
    if isinstance(remittance, str):
        remittance = [remittance]
    text = " ".join(r.strip() for r in remittance if r and r.strip())
    if not text:
        text = (tx.get("note") or tx.get("reference_number") or "").strip()
    return counterparty[:200], text[:500]


def transaction_date(tx: dict) -> str | None:
    return tx.get("booking_date") or tx.get("value_date") or tx.get("transaction_date")


def pick_balance(balances: list[dict]) -> tuple[int, str] | None:
    def rank(b):
        t = b.get("balance_type")
        return BALANCE_TYPES.index(t) if t in BALANCE_TYPES else len(BALANCE_TYPES)

    for b in sorted(balances, key=rank):
        amount = (b.get("balance_amount") or {}).get("amount")
        if amount is not None:
            when = b.get("reference_date") or (b.get("last_change_date_time") or "")[:10] or date.today().isoformat()
            return _cents(amount), when
    return None


def _ext_ids(transactions: list[dict]) -> list[str]:
    """A stable id per transaction. Banks don't all send one, so fall back to a
    fingerprint numbered within its day (two identical coffees on one day)."""
    seen: dict[str, int] = defaultdict(int)
    out = []
    for tx in transactions:
        ref = tx.get("entry_reference") or tx.get("transaction_id")
        if ref:
            out.append("ref:" + str(ref))
            continue
        counterparty, text = transaction_texts(tx)
        base = hashlib.sha1(f"{transaction_date(tx)}|{transaction_cents(tx)}|{counterparty}|{text}".encode()).hexdigest()[:20]
        seen[base] += 1
        out.append(f"h:{base}:{seen[base]}")
    return out


# --------------------------------------------------------------------------
# Connecting a bank


def connect_start(conn: sqlite3.Connection, bdir: Path, aspsp_name: str, country: str, redirect_url: str) -> str:
    """Ask Enable Banking for the bank's login page; returns its URL."""
    eb = client(bdir)
    info = next((a for a in eb.aspsps(country) if a.get("name") == aspsp_name), {})
    days = CONSENT_DAYS
    if info.get("maximum_consent_validity"):
        days = min(days, int(info["maximum_consent_validity"]) // 86400)
    valid_until = datetime.now(timezone.utc) + timedelta(days=max(1, days))
    state = secrets.token_urlsafe(24)
    conn.execute("DELETE FROM bank_pending WHERE created < ?", (int(time.time()) - 3600,))
    conn.execute(
        "INSERT INTO bank_pending (state, aspsp_name, aspsp_country, psu_headers, created) VALUES (?, ?, ?, ?, ?)",
        (state, aspsp_name, country, json.dumps(info.get("required_psu_headers") or []), int(time.time())),
    )
    r = eb.start_auth(
        {
            "access": {"valid_until": valid_until.isoformat(timespec="seconds")},
            "aspsp": {"name": aspsp_name, "country": country},
            "state": state,
            "redirect_url": redirect_url,
            "psu_type": "personal",
        }
    )
    return r["url"]


def _account_ident(acc: dict) -> str:
    ids = acc.get("account_id") or {}
    if ids.get("iban"):
        return "iban:" + ids["iban"].replace(" ", "").upper()
    if acc.get("identification_hash"):
        return "hash:" + acc["identification_hash"]
    other = (ids.get("other") or {}).get("identification")
    if other:
        return "other:" + str(other)
    return "uid:" + acc["uid"]


def connect_finish(conn: sqlite3.Connection, bdir: Path, code: str, state: str) -> str:
    """Turn the code the bank sent back into a session and its accounts."""
    pending = conn.execute("SELECT * FROM bank_pending WHERE state = ?", (state,)).fetchone()
    if not pending:
        raise BankError(400, "UNKNOWN_STATE", "this bank login was not started here, or it took too long")
    session = client(bdir).create_session(code)
    with db.transaction(conn):
        conn.execute("DELETE FROM bank_pending WHERE state = ?", (state,))
        # Earlier logins to the same bank: their accounts are checked against this one's below.
        earlier = [r[0] for r in conn.execute(
            "SELECT id FROM bank_sessions WHERE aspsp_name = ? AND aspsp_country = ?", (pending["aspsp_name"], pending["aspsp_country"])
        )]
        # Updated in place: replacing the row would cut its accounts loose.
        conn.execute(
            "INSERT INTO bank_sessions (id, aspsp_name, aspsp_country, valid_until, psu_headers, status, created) "
            "VALUES (?, ?, ?, ?, ?, 'active', ?) ON CONFLICT (id) DO UPDATE SET valid_until = excluded.valid_until, "
            "psu_headers = excluded.psu_headers, status = 'active', last_error = NULL",
            (
                session["session_id"], pending["aspsp_name"], pending["aspsp_country"],
                (session.get("access") or {}).get("valid_until") or "", pending["psu_headers"], int(time.time()),
            ),
        )
        idents = []
        for acc in session.get("accounts") or []:
            ident = _account_ident(acc)
            idents.append(ident)
            iban = (acc.get("account_id") or {}).get("iban")
            name = acc.get("name") or acc.get("product") or iban or "Account"
            # Logging in to the same bank again keeps each account's links and history.
            conn.execute(
                "INSERT INTO bank_accounts (session_id, uid, ident, name, iban, currency) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (ident) DO UPDATE SET session_id = excluded.session_id, uid = excluded.uid, "
                "name = excluded.name, iban = excluded.iban, currency = excluded.currency",
                (session["session_id"], acc["uid"], ident, name, iban, acc.get("currency")),
            )
        # Logging in to the same bank again: an account it no longer shares was
        # removed at the bank or in Enable Banking, so it goes here too.
        sessions = list({*earlier, session["session_id"]})
        gone = conn.execute(
            f"SELECT id FROM bank_accounts WHERE session_id IN ({','.join('?' * len(sessions))}) "
            f"AND ident NOT IN ({','.join('?' * len(idents))})",
            (*sessions, *idents),
        ).fetchall()
        for row in gone:
            remove_bank_account(conn, row[0])
        ensure_accounts(conn)
        # A session that no longer has accounts was replaced by this one.
        conn.execute(
            "DELETE FROM bank_sessions WHERE id != ? AND id NOT IN (SELECT session_id FROM bank_accounts WHERE session_id IS NOT NULL)",
            (session["session_id"],),
        )
    return session["session_id"]


_SAVINGS = re.compile(r"opspar|spare|savings|saving|sparkonto|børneopsparing", re.IGNORECASE)


def ensure_accounts(conn: sqlite3.Connection) -> None:
    """Every bank account is an account in Sparegrisen, its own one: the bank
    decides which accounts there are, and the person names them. A new bank
    account takes over a manual account with the same name, or the free
    budget or savings account of its kind (the ones set up with the
    household), or else becomes a new account named like at the bank: the
    budget account if there is none, else a savings or expense account.
    Only the budget account's transactions are reconciled with the budget
    (IN_BUDGET); the others follow the balance."""
    accounts = [dict(r) for r in conn.execute("SELECT * FROM accounts ORDER BY sort, id")]
    linked: set[int] = set()
    todo = []
    for ba in conn.execute("SELECT * FROM bank_accounts ORDER BY id").fetchall():
        if ba["account_id"] is not None and ba["account_id"] not in linked and any(a["id"] == ba["account_id"] for a in accounts):
            linked.add(ba["account_id"])
        else:
            todo.append(ba)  # new, or sharing an account with another bank account
    for ba in todo:
        name = (ba["name"] or "").strip()
        savings = bool(_SAVINGS.search(name))
        free = [a for a in accounts if a["id"] not in linked and not a["archived"]]
        match = next((a for a in free if a["name"].strip().lower() == name.lower()), None)
        if match is None:
            match = next((a for a in free if a["kind"] == ("savings" if savings else "main")), None)
        if match is None:
            # One budget account; other everyday accounts are expense accounts.
            has_main = any(a["kind"] == "main" for a in accounts)
            kind = "savings" if savings else "expense" if has_main else "main"
            cur = conn.execute(
                "INSERT INTO accounts (name, kind, color, sort, in_overview) "
                "VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM accounts), ?)",
                (name or "Bank", kind, len(accounts) % 8, int(kind != "expense")),
            )
            match = {"id": cur.lastrowid, "name": name, "kind": kind, "archived": 0}
            accounts.append(match)
        linked.add(match["id"])
        conn.execute("UPDATE bank_accounts SET account_id = ? WHERE id = ?", (match["id"], ba["id"]))


def remove_bank_account(conn: sqlite3.Connection, bank_account_id: int) -> None:
    """Erase a bank account that is gone upstream: its transactions, and the
    account in Sparegrisen with its balances. Items that moved money to it keep
    their amounts but no longer point at an account."""
    row = conn.execute("SELECT account_id FROM bank_accounts WHERE id = ?", (bank_account_id,)).fetchone()
    conn.execute("DELETE FROM bank_accounts WHERE id = ?", (bank_account_id,))  # transactions go with it
    if row and row[0] is not None:
        conn.execute("DELETE FROM accounts WHERE id = ?", (row[0],))  # balances go with it


def disconnect(conn: sqlite3.Connection, bdir: Path, session_id: str) -> None:
    """Remove a bank connection, and with it its accounts and their data."""
    try:
        client(bdir).delete_session(session_id)
    except BankError:
        pass  # already gone at the bank's end; forget it here anyway
    with db.transaction(conn):
        for row in conn.execute("SELECT id FROM bank_accounts WHERE session_id = ?", (session_id,)).fetchall():
            remove_bank_account(conn, row[0])
        conn.execute("DELETE FROM bank_sessions WHERE id = ?", (session_id,))


# --------------------------------------------------------------------------
# Sorting transactions onto budget items


def _assign(conn, tx_id: int, item_id: int | None, ignored: bool, year: int) -> None:
    conn.execute("UPDATE bank_transactions SET item_id = ?, ignored = ? WHERE id = ?", (item_id, int(ignored), tx_id))
    if item_id is not None:
        # An item paid in a year belongs to that year's budget.
        conn.execute("INSERT OR IGNORE INTO item_years (item_id, year) VALUES (?, ?)", (item_id, year))


def save_rule(conn: sqlite3.Connection, pattern: str, item_id: int | None, amount_cents: int | None) -> int | None:
    """Save "text containing pattern (for amount) goes to item_id" (None:
    ignore it), keeping one rule per text and item: an existing one for the
    same text and item is changed instead (its amount), and one sending the
    same text and amount elsewhere is dropped, as the newest choice wins.
    Text is compared without case, as rules match. Returns the id of a new
    rule, or None when an existing one was changed."""
    pattern = pattern.strip()
    ignore = int(item_id is None)
    same_text = [r for r in conn.execute("SELECT * FROM bank_rules ORDER BY id DESC").fetchall()
                 if r["pattern"].strip().lower() == pattern.lower()]
    mine = [r for r in same_text if r["item_id"] == item_id and r["ignore"] == ignore]
    for r in same_text:
        if r not in mine and r["amount_cents"] == amount_cents:
            conn.execute("DELETE FROM bank_rules WHERE id = ?", (r["id"],))
    if mine:
        conn.execute("UPDATE bank_rules SET pattern = ?, amount_cents = ? WHERE id = ?", (pattern, amount_cents, mine[0]["id"]))
        for r in mine[1:]:
            conn.execute("DELETE FROM bank_rules WHERE id = ?", (r["id"],))
        return None
    return conn.execute(
        "INSERT INTO bank_rules (pattern, item_id, ignore, amount_cents) VALUES (?, ?, ?, ?)", (pattern, item_id, ignore, amount_cents)
    ).lastrowid


def not_item(conn: sqlite3.Connection, tx_id: int, item_id: int) -> None:
    """Remember that a transaction is not this item, and drop the rules that
    would put it there (they would on the next sync)."""
    conn.execute("INSERT OR IGNORE INTO bank_not_item (transaction_id, item_id) VALUES (?, ?)", (tx_id, item_id))
    tx = conn.execute("SELECT * FROM bank_transactions WHERE id = ?", (tx_id,)).fetchone()
    for rule in conn.execute("SELECT * FROM bank_rules WHERE item_id = ?", (item_id,)).fetchall():
        if _rule_matches(rule, tx):
            conn.execute("DELETE FROM bank_rules WHERE id = ?", (rule["id"],))


def _rule_matches(rule, tx) -> bool:
    if rule["amount_cents"] is not None and abs(tx["cents"]) != rule["amount_cents"]:
        return False
    return rule["pattern"].lower() in f"{tx['counterparty']} {tx['text']}".lower()


def apply_rules(conn: sqlite3.Connection, only_ids: list[int] | None = None) -> int:
    """Sort unsorted transactions with the saved rules. Newer rules win. A
    rule with an amount only takes transactions of exactly that amount, so a
    payment that changed is left unsorted for someone to look at."""
    rules = conn.execute("SELECT * FROM bank_rules ORDER BY id DESC").fetchall()
    if not rules:
        return 0
    sql = "SELECT * FROM bank_transactions WHERE item_id IS NULL AND ignored = 0"
    args: list = []
    if only_ids is not None:
        if not only_ids:
            return 0
        sql += f" AND id IN ({','.join('?' * len(only_ids))})"
        args = only_ids
    sorted_count = 0
    refused = {(r[0], r[1]) for r in conn.execute("SELECT transaction_id, item_id FROM bank_not_item")}
    for tx in conn.execute(sql, args).fetchall():
        for rule in rules:
            if (tx["id"], rule["item_id"]) in refused:
                continue
            if _rule_matches(rule, tx):
                _assign(conn, tx["id"], rule["item_id"], bool(rule["ignore"]), tx["year"])
                sorted_count += 1
                break
    return sorted_count


# Words that change from one month's payment to the next, so a rule shouldn't need them.
_CHANGING = {
    "januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december",
    "january", "february", "march", "may", "june", "july", "october",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "okt", "oct", "nov", "dec",
}


# How a payment was made, from the short code banks put in front of the text:
# "MCD NETFLIX.COM" is a Mastercard payment, "BS Ørsted" Betalingsservice.
PAYMENT_TYPES = [
    (r"(MCD|MC|MASTERCARD)", "Mastercard"),
    (r"(VISA/DANKORT|VISA|VDK)", "Visa"),
    (r"(DANKORT-NOTA|DK-NOTA|DANKORT)", "Dankort"),
    (r"(BS|BETALINGSSERVICE)", "Betalingsservice"),
    (r"(LS|LEVERANDØRSERVICE)", "Leverandørservice"),
    (r"(MOBILEPAY|MOBILE PAY)", "MobilePay"),
]
_TYPE_RE = [(re.compile(rf"^\s*{code}(?=[\s:.\-/]|$)[\s:.\-/]*", re.I), name) for code, name in PAYMENT_TYPES]


def payment_type(text: str) -> tuple[str | None, str]:
    """(how it was paid, the text without that code), or (None, text)."""
    for pattern, name in _TYPE_RE:
        m = pattern.match(text or "")
        if m and m.end() < len(text):
            return name, text[m.end():].strip()
    return None, text or ""


def suggest_pattern(counterparty: str, text: str) -> str:
    """What a rule should look for: the counterparty, or the first words of
    the text without the payment-type code, dates, numbers and month names."""
    if counterparty:
        return payment_type(counterparty)[1]
    text = payment_type(text)[1]
    words = [
        w for w in text.split()
        if not any(ch.isdigit() for ch in w) and w.lower().strip(".,:") not in _CHANGING
    ]
    return " ".join(words[:2]) or text[:30]


# --------------------------------------------------------------------------
# Syncing


def _month_end(y: int, m: int) -> date:
    return (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)


def measure_day(y: int, m: int, mode: str = "last") -> date:
    """The day a month's balance is read at the end of: the last day of the
    month, or with 'before_payday' the day before the month's last weekday,
    before the salary that usually comes then makes every account look full."""
    end = _month_end(y, m)
    if mode != "before_payday":
        return end
    while end.weekday() >= 5:  # Saturday, Sunday
        end -= timedelta(days=1)
    return end - timedelta(days=1)


def budget_month(day: str, mode: str = "last") -> tuple[int, int]:
    """The budget month a transaction booked on day (ISO) belongs to. With
    'before_payday' a month runs from the previous month's last weekday, when
    the salary comes, to the day before its own: the salary paid on 30
    September is October's."""
    d = date.fromisoformat(day[:10])
    if mode == "before_payday" and d > measure_day(d.year, d.month, mode):
        return (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return d.year, d.month


def move_transaction(conn: sqlite3.Connection, tx_id: int, year: int | None, month: int | None) -> None:
    """Put a transaction in another budget month, or back in its own (None)."""
    if year is None or month is None:
        r = conn.execute("SELECT booking_date FROM bank_transactions WHERE id = ?", (tx_id,)).fetchone()
        year, month = budget_month(r[0], balance_day_mode(conn))
        conn.execute("UPDATE bank_transactions SET year = ?, month = ?, manual_month = 0 WHERE id = ?", (year, month, tx_id))
    else:
        conn.execute("UPDATE bank_transactions SET year = ?, month = ?, manual_month = 1 WHERE id = ?", (year, month, tx_id))
    item = conn.execute("SELECT item_id FROM bank_transactions WHERE id = ?", (tx_id,)).fetchone()[0]
    if item is not None:
        conn.execute("INSERT OR IGNORE INTO item_years (item_id, year) VALUES (?, ?)", (item, year))


def regroup_transactions(conn: sqlite3.Connection) -> None:
    """Put every transaction in its budget month again, after the setting
    changed; those moved by hand stay."""
    mode = balance_day_mode(conn)
    for r in conn.execute("SELECT id, booking_date, item_id FROM bank_transactions WHERE manual_month = 0").fetchall():
        y, m = budget_month(r["booking_date"], mode)
        conn.execute("UPDATE bank_transactions SET year = ?, month = ? WHERE id = ?", (y, m, r["id"]))
        if r["item_id"] is not None:
            conn.execute("INSERT OR IGNORE INTO item_years (item_id, year) VALUES (?, ?)", (r["item_id"], y))


def reconciled_months(conn: sqlite3.Connection) -> list[str]:
    """"year-month" of each budget month that is over and fully reconciled:
    it has transactions on the budget account and every one is on an item
    or ignored."""
    mode = balance_day_mode(conn)
    today = date.today()
    return [
        f"{r['year']}-{r['month']}"
        for r in conn.execute(
            "SELECT t.year, t.month, SUM(t.item_id IS NULL AND t.ignored = 0) AS open FROM bank_transactions t "
            f"JOIN bank_accounts b ON b.id = t.bank_account_id WHERE {IN_BUDGET} GROUP BY t.year, t.month"
        )
        if not r["open"] and measure_day(r["year"], r["month"], mode) < today
    ]


def balance_day_mode(conn: sqlite3.Connection) -> str:
    r = conn.execute("SELECT value FROM settings WHERE key = 'balance_day'").fetchone()
    return "before_payday" if r and json.loads(r[0]) == "before_payday" else "last"


def update_month_balances(conn: sqlite3.Connection) -> None:
    """Save the real end-of-month balance of every Sparegrisen account that has
    bank accounts linked, for each month their transactions cover whose
    measuring day (see measure_day) is over. A balance typed in by hand is
    left alone."""
    mode = bank_mode(conn)
    groups: dict[int, list] = defaultdict(list)
    for ba in conn.execute(
        "SELECT * FROM bank_accounts WHERE account_id IS NOT NULL AND balance_cents IS NOT NULL AND history_from IS NOT NULL"
    ):
        groups[ba["account_id"]].append(ba)
    today = date.today()
    day_mode = balance_day_mode(conn)
    for account_id, bank_accounts in groups.items():
        # The months every linked bank account can say something about, up
        # to the last one whose measuring day is over.
        start = max(date.fromisoformat(ba["history_from"]) for ba in bank_accounts) - timedelta(days=1)
        months = []
        y, m = start.year, start.month
        while date(y, m, 1) <= today:
            end = measure_day(y, m, day_mode)
            if start <= end < today:
                months.append((y, m, end))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        totals: dict[tuple[int, int], int] = defaultdict(int)
        for ba in bank_accounts:
            ref = ba["balance_date"] or date.today().isoformat()
            rows = conn.execute(
                "SELECT booking_date, cents FROM bank_transactions WHERE bank_account_id = ? AND booking_date <= ?",
                (ba["id"], ref),
            ).fetchall()
            for y, m, end in months:
                after = sum(r["cents"] for r in rows if r["booking_date"] > end.isoformat())
                totals[(y, m)] += ba["balance_cents"] - after
        for (y, m), cents in totals.items():
            cents = db.round_cents(cents, mode)
            conn.execute(
                "INSERT INTO account_balances (account_id, year, month, cents, source) VALUES (?, ?, ?, ?, 'bank') "
                "ON CONFLICT (account_id, year, month) DO UPDATE SET cents = excluded.cents "
                "WHERE account_balances.source = 'bank'",
                (account_id, y, m, cents),
            )


def _psu_for(session, psu: dict | None) -> dict | None:
    """Headers telling the bank the user is present (so it doesn't count
    toward the few automatic fetches a day banks allow). The bank says which
    it requires: send all of those, or none."""
    if not psu:
        return None
    required = json.loads(session["psu_headers"] or "[]")
    have = {k.lower() for k in psu}
    if any(r.lower() not in have for r in required):
        return None
    return psu


def sync(conn: sqlite3.Connection, bdir: Path, psu: dict | None = None) -> dict:
    with _sync_lock:
        return _sync(conn, bdir, psu)


def _sync(conn: sqlite3.Connection, bdir: Path, psu: dict | None) -> dict:
    eb = client(bdir)
    with db.transaction(conn):
        ensure_accounts(conn)
    new_ids: list[int] = []
    errors: list[str] = []
    now = datetime.now(timezone.utc)
    for session in conn.execute("SELECT * FROM bank_sessions WHERE status = 'active'").fetchall():
        try:
            until = datetime.fromisoformat(session["valid_until"].replace("Z", "+00:00"))
            if until.tzinfo is None:
                until = until.replace(tzinfo=timezone.utc)
            if until < now:
                conn.execute("UPDATE bank_sessions SET status = 'expired' WHERE id = ?", (session["id"],))
                continue
        except ValueError:
            pass
        headers = _psu_for(session, psu)
        error = None
        try:
            info = eb.get_session(session["id"])
        except BankError as e:
            if e.code in SESSION_GONE or e.status in (401, 404):
                conn.execute("UPDATE bank_sessions SET status = 'expired' WHERE id = ?", (session["id"],))
                continue
            info = None  # couldn't ask; sync what we have
        if info is not None:
            if info.get("status") not in (None, "AUTHORIZED"):
                conn.execute("UPDATE bank_sessions SET status = 'expired' WHERE id = ?", (session["id"],))
                continue
            # Accounts the bank no longer shares were removed upstream: erase them.
            shared = set(info.get("accounts") or [])
            if shared:
                with db.transaction(conn):
                    for ba in conn.execute("SELECT id, uid FROM bank_accounts WHERE session_id = ?", (session["id"],)).fetchall():
                        if ba["uid"] not in shared:
                            remove_bank_account(conn, ba["id"])
        for ba in conn.execute("SELECT * FROM bank_accounts WHERE session_id = ?", (session["id"],)).fetchall():
            try:
                new_ids += _sync_account(conn, eb, ba, headers)
            except BankError as e:
                if e.code == "ACCOUNT_DOES_NOT_EXIST":
                    with db.transaction(conn):
                        remove_bank_account(conn, ba["id"])
                    continue
                error = f"{ba['name']}: {e}"
                if e.code in SESSION_GONE or e.status == 401:
                    conn.execute("UPDATE bank_sessions SET status = 'expired' WHERE id = ?", (session["id"],))
                    break
        conn.execute(
            "UPDATE bank_sessions SET last_sync = ?, last_error = ? WHERE id = ?", (int(time.time()), error, session["id"])
        )
        if error:
            errors.append(f"{session['aspsp_name']}: {error}")
    sorted_count = apply_rules(conn, new_ids)
    update_month_balances(conn)
    return {"new": len(new_ids), "sorted": sorted_count, "errors": errors}


def _sync_account(conn: sqlite3.Connection, eb: EnableBanking, ba, psu: dict | None) -> list[int]:
    day_mode = balance_day_mode(conn)
    balance = pick_balance(eb.balances(ba["uid"], psu))
    if ba["synced_to"]:
        date_from = (date.fromisoformat(ba["synced_to"]) - timedelta(days=OVERLAP_DAYS)).isoformat()
        transactions = eb.transactions(ba["uid"], psu, date_from, "default")
    else:
        # First sync: as much history as the bank will give.
        date_from = None
        transactions = eb.transactions(ba["uid"], psu, None, "longest")

    booked = [tx for tx in transactions if (tx.get("status") or "BOOK") == "BOOK" and transaction_date(tx)]
    booked.sort(key=transaction_date)
    new_ids = []
    with db.transaction(conn):
        for tx, ext_id in zip(booked, _ext_ids(booked)):
            day = transaction_date(tx)[:10]
            y, m = budget_month(day, day_mode)
            counterparty, text = transaction_texts(tx)
            cents = transaction_cents(tx)
            existing = conn.execute(
                "SELECT id FROM bank_transactions WHERE bank_account_id = ? AND ext_id = ?", (ba["id"], ext_id)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE bank_transactions SET booking_date = ?, cents = ?, counterparty = ?, text = ?, "
                    "year = CASE WHEN manual_month THEN year ELSE ? END, month = CASE WHEN manual_month THEN month ELSE ? END "
                    "WHERE id = ?",
                    (day, cents, counterparty, text, y, m, existing[0]),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO bank_transactions (bank_account_id, ext_id, booking_date, year, month, cents, counterparty, text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (ba["id"], ext_id, day, y, m, cents, counterparty, text),
                )
                new_ids.append(cur.lastrowid)
        days = [transaction_date(tx)[:10] for tx in booked]
        earliest = date_from or (days[0] if days else date.today().isoformat())
        history_from = min(filter(None, [ba["history_from"], earliest]))
        synced_to = max(filter(None, [ba["synced_to"], days[-1] if days else None, date.today().isoformat()]))
        conn.execute(
            "UPDATE bank_accounts SET balance_cents = ?, balance_date = ?, history_from = ?, synced_to = ? WHERE id = ?",
            (balance[0] if balance else ba["balance_cents"], balance[1] if balance else ba["balance_date"], history_from, synced_to, ba["id"]),
        )
    return new_ids


def due_for_sync(conn: sqlite3.Connection, bdir: Path) -> bool:
    if SYNC_HOURS <= 0 or not get_config(bdir):
        return False
    cutoff = int(time.time() - SYNC_HOURS * 3600)
    return bool(
        conn.execute(
            "SELECT 1 FROM bank_sessions WHERE status = 'active' AND (last_sync IS NULL OR last_sync < ?)", (cutoff,)
        ).fetchone()
    )


# --------------------------------------------------------------------------
# Transactions for the app


# A bank account (aliased b) whose transactions are reconciled with the
# budget: the budget account's. Money moved to savings or expense accounts is
# already in the budget as the transfer out of the budget account.
IN_BUDGET = "b.account_id IN (SELECT id FROM accounts WHERE kind = 'main')"


def bank_mode(conn: sqlite3.Connection) -> str:
    """How the bank's amounts are rounded. They can't be refused, so with
    whole numbers only they go to the nearest whole number."""
    mode = db.decimals_mode(conn)
    return "nearest" if mode == "only" else mode


def actuals(conn: sqlite3.Connection, year: int) -> dict[int, list[int | None]]:
    """item_id -> 12 monthly totals of the bank transactions sorted onto it,
    as positive amounts in the item's own direction."""
    mode = bank_mode(conn)
    out: dict[int, list[int | None]] = defaultdict(lambda: [None] * 12)
    for r in conn.execute(
        "SELECT t.item_id, t.month, t.cents, i.kind FROM bank_transactions t "
        "JOIN items i ON i.id = t.item_id JOIN bank_accounts b ON b.id = t.bank_account_id "
        f"WHERE t.year = ? AND t.ignored = 0 AND {IN_BUDGET}",
        (year,),
    ):
        cents = db.round_cents(r["cents"], mode)
        months = out[r["item_id"]]
        months[r["month"] - 1] = (months[r["month"] - 1] or 0) + (cents if r["kind"] == "income" else -cents)
    return out


def month_transactions(conn: sqlite3.Connection, year: int, month: int) -> list[dict]:
    """The month's transactions on the budget account, with suggested items
    for unsorted ones (never one it was turned down for). account_name is the
    name given in Sparegrisen."""
    rows = [
        dict(r)
        for r in conn.execute(
            "SELECT t.*, COALESCE(a.name, b.name) AS account_name FROM bank_transactions t "
            "JOIN bank_accounts b ON b.id = t.bank_account_id LEFT JOIN accounts a ON a.id = b.account_id "
            f"WHERE t.year = ? AND t.month = ? AND {IN_BUDGET} ORDER BY t.booking_date DESC, t.id DESC",
            (year, month),
        )
    ]
    planned = conn.execute(
        "SELECT i.id, i.name, i.kind, a.cents FROM items i LEFT JOIN amounts a ON a.item_id = i.id AND a.year = ? AND a.month = ? "
        "WHERE i.id IN (SELECT item_id FROM item_years WHERE year = ? UNION SELECT item_id FROM amounts WHERE year = ?)",
        (year, month, year, year),
    ).fetchall()
    mode = bank_mode(conn)
    refused: dict[int, list[int]] = defaultdict(list)
    for r in conn.execute("SELECT transaction_id, item_id FROM bank_not_item"):
        refused[r[0]].append(r[1])
    for tx in rows:
        tx["cents"] = db.round_cents(tx["cents"], mode)
        tx["not_items"] = refused.get(tx["id"], [])  # items it was taken off or turned down for
        tx["suggestions"] = []
        if tx["item_id"] is None and not tx["ignored"]:
            kind = "income" if tx["cents"] > 0 else "expense"
            haystack = f"{tx['counterparty']} {tx['text']}".lower()
            scored = []
            for item in planned:
                if item["kind"] != kind or item["id"] in tx["not_items"]:
                    continue
                score = 0
                if item["cents"] is not None and item["cents"] == abs(tx["cents"]):
                    score += 2
                words = [w for w in item["name"].lower().replace("/", " ").split() if len(w) >= 4]
                if any(w in haystack for w in words):
                    score += 3
                if score:
                    scored.append((score, item["id"]))
            tx["suggestions"] = [i for _, i in sorted(scored, key=lambda s: -s[0])[:3]]
        tx["amount"] = db.from_cents(tx.pop("cents"))
        tx["ignored"] = bool(tx["ignored"])
        tx["manual_month"] = bool(tx["manual_month"])
        tx["pattern"] = suggest_pattern(tx["counterparty"], tx["text"])
        tx["via"] = payment_type(tx["text"])[0] or payment_type(tx["counterparty"])[0]
    return rows


def balance_history(conn: sqlite3.Connection, account_id: int, year: int) -> list[dict]:
    """The balance of an account after every bank transaction in year,
    oldest first, worked back from the bank's latest balance. Empty when no
    bank account with a balance is linked."""
    linked = conn.execute(
        "SELECT id, balance_cents, balance_date FROM bank_accounts WHERE account_id = ? AND balance_cents IS NOT NULL",
        (account_id,),
    ).fetchall()
    if not linked:
        return []
    mode = bank_mode(conn)
    ids = [b["id"] for b in linked]
    rows = conn.execute(
        f"SELECT booking_date, cents, counterparty, text FROM bank_transactions WHERE bank_account_id IN ({','.join('?' * len(ids))}) "
        "ORDER BY booking_date DESC, id DESC",
        ids,
    ).fetchall()
    balance = sum(b["balance_cents"] for b in linked)
    ref = max(b["balance_date"] or date.today().isoformat() for b in linked)
    points = [{"date": ref, "balance": balance, "amount": None, "text": None, "via": None}]
    for r in rows:
        if r["booking_date"] > ref:
            continue
        points.append({"date": r["booking_date"], "balance": balance, "amount": r["cents"],
                       "text": payment_type(r["counterparty"] or r["text"])[1] or r["text"],
                       "via": payment_type(r["text"])[0] or payment_type(r["counterparty"])[0]})
        balance -= r["cents"]
        if r["booking_date"] < f"{year}-01-01":
            break
    points = [p for p in reversed(points) if p["date"].startswith(str(year))]
    for p in points:
        p["balance"] = db.from_cents(db.round_cents(p["balance"], mode))
        p["amount"] = None if p["amount"] is None else db.from_cents(db.round_cents(p["amount"], mode))
    return points
