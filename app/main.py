import asyncio
import json
import logging
import shutil
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from urllib.parse import quote

from . import __version__, auth, backup, banking, calc, checks, db, importer
from . import env as getenv
from . import export_xlsx as export_workbook

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
Kind = Literal["income", "expense"]
MAX_IMPORT_BYTES = 10 * 1024 * 1024



log = logging.getLogger("sparegrisen")


class AppError(HTTPException):
    """An error the app shows to people: the code lets it say it in their language."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(status, {"code": code, "message": message})


def budget_ids() -> list[int]:
    server = db.open_server()
    try:
        return [r[0] for r in server.execute("SELECT id FROM budgets")]
    finally:
        server.close()


def _scheduled_sync() -> None:
    for budget_id in budget_ids():
        conn = db.open_budget(budget_id)
        try:
            if banking.due_for_sync(conn, db.budget_dir(budget_id)):
                result = banking.sync(conn, db.budget_dir(budget_id))
                log.info("bank sync of budget %s: %s", budget_id, result)
        except Exception:
            log.exception("bank sync of budget %s failed", budget_id)
        finally:
            conn.close()


async def _bank_sync_loop() -> None:
    """Sync connected banks every SPAREGRISEN_BANK_SYNC_HOURS (checked every 10 minutes)."""
    while True:
        await asyncio.sleep(600)
        try:
            await asyncio.to_thread(_scheduled_sync)
        except Exception:
            log.exception("scheduled bank sync failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    for budget_id in budget_ids():  # brings every budget's database up to date
        conn = db.open_budget(budget_id)
        with db.transaction(conn):
            banking.ensure_accounts(conn)  # one account per bank account, also for data from before
        conn.close()
    task = asyncio.create_task(_bank_sync_loop())
    yield
    task.cancel()


app = FastAPI(
    title="Sparegrisen", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json"
)


def get_conn(request: Request):
    """The logged-in budget's database."""
    conn = db.open_budget(request.state.budget_id)
    try:
        yield conn
    finally:
        conn.close()


Conn = Depends(get_conn)


def budget_dir(request: Request) -> Path:
    return db.budget_dir(request.state.budget_id)


@app.exception_handler(banking.BankError)
async def bank_error(request: Request, exc: banking.BankError):
    status = 400 if exc.code in ("NOT_CONFIGURED", "UNKNOWN_STATE") else 502
    return JSONResponse({"detail": {"code": exc.code, "message": str(exc)}}, status_code=status)


OPEN_PATHS = {"/api/session", "/api/login", "/api/logout", "/api/health", "/api/budgets"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every API call works on the budget the session cookie belongs to."""
    path = request.url.path
    if path.startswith("/api/") and path not in OPEN_PATHS:
        budget_id = auth.budget_from_token(request.cookies.get(auth.COOKIE))
        if budget_id is None:
            if path == "/api/bank/callback":  # a browser coming back from the bank
                return RedirectResponse("/", status_code=303)
            return JSONResponse({"detail": "login required"}, status_code=401)
        request.state.budget_id = budget_id
    response = await call_next(request)
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------------
# Helpers


def rows(cursor) -> list[dict]:
    return [dict(r) for r in cursor.fetchall()]


def one(conn, sql, args=()) -> dict:
    r = conn.execute(sql, args).fetchone()
    if r is None:
        raise AppError(404, "NOT_FOUND", "not found")
    return dict(r)


def amount_cents(conn, value: float | None) -> int | None:
    """An amount typed or imported, in cents, as the budget's decimals setting
    says: rounded to whole units, or refused when it has decimals and only
    whole numbers are accepted."""
    cents = db.to_cents(value)
    mode = db.decimals_mode(conn)
    if mode == "only" and cents is not None and cents % 100:
        raise AppError(422, "WHOLE_NUMBERS", "only whole numbers are accepted")
    return db.round_cents(cents, mode)


def cents_list(conn, values: list[float | None]) -> list[int | None]:
    if len(values) != 12:
        raise AppError(422, "INVALID", "amounts must have 12 values")
    return [amount_cents(conn, v) for v in values]


def money_list(values: list[int | None]) -> list[float | None]:
    return [db.from_cents(v) for v in values]


def get_settings(conn) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT key, value FROM settings")}


def set_settings(conn, values: dict) -> None:
    for key, value in values.items():
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )


def next_sort(conn, table: str) -> int:
    return conn.execute(f"SELECT COALESCE(MAX(sort), -1) + 1 FROM {table}").fetchone()[0]


def set_amounts(conn, item_id: int, year: int, values: list[int | None]) -> None:
    conn.execute("DELETE FROM amounts WHERE item_id = ? AND year = ?", (item_id, year))
    conn.executemany(
        "INSERT INTO amounts (item_id, year, month, cents) VALUES (?, ?, ?, ?)",
        [(item_id, year, m + 1, v) for m, v in enumerate(values) if v is not None],
    )
    conn.execute("INSERT OR IGNORE INTO item_years (item_id, year) VALUES (?, ?)", (item_id, year))


def unreadable_cells(conn, year: int) -> dict[int, list[str | None]]:
    out: dict[int, list[str | None]] = {}
    for r in conn.execute("SELECT item_id, month, raw FROM unreadable WHERE year = ?", (year,)):
        out.setdefault(r["item_id"], [None] * 12)[r["month"] - 1] = r["raw"]
    return out


def item_out(item: dict, amounts: list[int | None], prev: list[int | None], actual: list[int | None] | None = None,
             unreadable: list[str | None] | None = None) -> dict:
    return {
        **item,
        # Text an import couldn't read as an amount, per month.
        "unreadable": unreadable or [None] * 12,
        "fixed": bool(item["fixed"]),
        "amounts": money_list(amounts),
        "prev": money_list(prev),
        # What the bank transactions sorted onto this item add up to, per month.
        "actual": money_list(actual or [None] * 12),
    }


# --------------------------------------------------------------------------
# Session


class LoginIn(BaseModel):
    login: str = Field(max_length=200)
    password: str = Field(max_length=200)


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


def _normal_login(name: str) -> str:
    """The budget's name as it's logged in with: any case, any spacing."""
    return " ".join(name.split()).lower()


def _login_name(login: str) -> str:
    login = _normal_login(login)
    if len(login) < 2:
        raise AppError(422, "USERNAME_INVALID", "the budget name must be at least 2 characters")
    return login


def _set_session(request: Request, response: Response, budget_id: int, password_hash: str) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        auth.COOKIE,
        auth.make_token(budget_id, password_hash),
        max_age=auth.SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure,
    )


def _check_password(request: Request, row, password: str) -> None:
    client = request.client.host if request.client else "?"
    if auth.too_many_failures(client):
        raise AppError(429, "TOO_MANY_ATTEMPTS", "too many attempts, try again in 15 minutes")
    if row is None:
        auth.burn_time(password)
    if row is None or not auth.verify_password(password, row["password_hash"]):
        auth.record_failure(client)
        time.sleep(1)
        raise AppError(401, "WRONG_LOGIN", "wrong budget name or password")


@app.get("/api/session")
def session(request: Request):
    budget_id = auth.budget_from_token(request.cookies.get(auth.COOKIE))
    server = db.open_server()
    try:
        count = server.execute("SELECT COUNT(*) FROM budgets").fetchone()[0]
        budget = server.execute("SELECT id, name, login FROM budgets WHERE id = ?", (budget_id,)).fetchone()
    finally:
        server.close()
    return {
        "logged_in": budget is not None,
        "budget": dict(budget) if budget else None,
        "has_budgets": count > 0,
        "can_create": count == 0 or auth.allow_new_budgets(),
    }


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    server = db.open_server()
    try:
        row = server.execute("SELECT * FROM budgets WHERE login = ?", (_normal_login(body.login),)).fetchone()
    finally:
        server.close()
    _check_password(request, row, body.password)
    _set_session(request, response, row["id"], row["password_hash"])
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


class LoginDetailsIn(BaseModel):
    current_password: str = Field(max_length=200)
    login: str | None = Field(None, max_length=60)
    password: str | None = Field(None, min_length=auth.MIN_PASSWORD, max_length=200)


@app.put("/api/login-details")
def change_login_details(body: LoginDetailsIn, request: Request, response: Response):
    """Change the budget's username or password. Other devices are logged out
    by a new password; this one stays logged in."""
    server = db.open_server()
    try:
        row = server.execute("SELECT * FROM budgets WHERE id = ?", (request.state.budget_id,)).fetchone()
        _check_password(request, row, body.current_password)
        password_hash = row["password_hash"]
        with db.transaction(server):
            if body.login is not None:
                login = _login_name(body.login)
                taken = server.execute("SELECT 1 FROM budgets WHERE login = ? AND id != ?", (login, row["id"])).fetchone()
                if taken:
                    raise AppError(409, "USERNAME_TAKEN", "that budget name is taken")
                server.execute("UPDATE budgets SET login = ? WHERE id = ?", (login, row["id"]))
            if body.password is not None:
                password_hash = auth.hash_password(body.password)
                server.execute("UPDATE budgets SET password_hash = ? WHERE id = ?", (password_hash, row["id"]))
    finally:
        server.close()
    _set_session(request, response, row["id"], password_hash)
    return {"ok": True}


class DeleteBudgetIn(BaseModel):
    password: str = Field(max_length=200)


@app.post("/api/budget/delete")
def delete_budget(body: DeleteBudgetIn, request: Request, response: Response):
    server = db.open_server()
    try:
        row = server.execute("SELECT * FROM budgets WHERE id = ?", (request.state.budget_id,)).fetchone()
        _check_password(request, row, body.password)
        server.execute("DELETE FROM budgets WHERE id = ?", (row["id"],))
    finally:
        server.close()
    shutil.rmtree(db.budget_dir(row["id"]), ignore_errors=True)
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


# --------------------------------------------------------------------------
# Household setup and settings

DEFAULT_CATEGORIES = {
    "en": {
        "income": ["Salary", "Benefits & allowances", "Other income"],
        "expense": [
            "Housing", "Utilities", "Groceries", "Transport", "Insurance", "Subscriptions",
            "Childcare & school", "Health", "Loans & debt", "Savings", "Leisure", "Other",
        ],
    },
    "da": {
        "income": ["Løn", "Ydelser & tilskud", "Andre indtægter"],
        "expense": [
            "Bolig", "Forsyning", "Dagligvarer", "Transport", "Forsikring", "Abonnementer",
            "Børnepasning & skole", "Sundhed", "Lån & gæld", "Opsparing", "Fritid", "Andet",
        ],
    },
}
DEFAULT_ACCOUNTS = {
    "en": [("Budget account", "main"), ("Savings", "savings")],
    "da": [("Budgetkonto", "main"), ("Opsparing", "savings")],
}


class SetupIn(BaseModel):
    household: str = Field(min_length=1, max_length=100)
    language: str = "en"
    decimal: Literal[",", ".", "either"] = ","
    decimal_both: Literal["last", "invalid"] = "last"
    currency: str = "USD"
    members: list[str] = Field(min_length=1, max_length=20)
    shared_name: str = Field("Shared", min_length=1, max_length=60)
    starter_categories: bool = True
    # Accounts come from the bank, or are added by hand; none to start with.
    starter_accounts: bool = False


@app.get("/api/state")
def state(conn: sqlite3.Connection = Conn):
    years = [
        r[0]
        for r in conn.execute("SELECT DISTINCT year FROM amounts UNION SELECT DISTINCT year FROM item_years ORDER BY 1")
    ]
    members = rows(conn.execute("SELECT * FROM members ORDER BY is_shared, sort, id"))
    for m in members:
        m["is_shared"] = bool(m["is_shared"])
        m["archived"] = bool(m["archived"])
    accounts = rows(conn.execute("SELECT * FROM accounts ORDER BY sort, id"))
    for a in accounts:
        a["archived"] = bool(a["archived"])
        a["in_overview"] = bool(a["in_overview"])
    return {
        "version": __version__,
        "setup_done": bool(members),
        "settings": get_settings(conn),
        "members": members,
        "categories": rows(conn.execute("SELECT * FROM categories ORDER BY kind, sort, id")),
        "accounts": accounts,
        "years": years,
    }


class NewBudgetIn(SetupIn):
    # The budget is logged in to with its name; a separate login is optional.
    login: str | None = Field(None, max_length=100)
    password: str = Field(min_length=auth.MIN_PASSWORD, max_length=200)


@app.post("/api/budgets")
def create_budget(body: NewBudgetIn, request: Request, response: Response):
    """Create a budget with its login, set it up, and log in to it."""
    login = _login_name(body.login or body.household)
    password_hash = auth.hash_password(body.password)
    server = db.open_server()
    try:
        count = server.execute("SELECT COUNT(*) FROM budgets").fetchone()[0]
        if count and not auth.allow_new_budgets():
            raise AppError(403, "NEW_BUDGETS_OFF", "new budgets are turned off on this server")
        if server.execute("SELECT 1 FROM budgets WHERE login = ?", (login,)).fetchone():
            raise AppError(409, "USERNAME_TAKEN", "that budget name is taken")
        budget_id = server.execute(
            "INSERT INTO budgets (name, login, password_hash, created) VALUES (?, ?, ?, ?)",
            (body.household.strip(), login, password_hash, int(time.time())),
        ).lastrowid
    finally:
        server.close()
    conn = db.open_budget(budget_id)
    try:
        _setup_household(conn, body)
        out = state(conn)
    finally:
        conn.close()
    _set_session(request, response, budget_id, password_hash)
    return out


def _setup_household(conn: sqlite3.Connection, body: SetupIn) -> None:
    lang = body.language if body.language in DEFAULT_CATEGORIES else "en"
    with db.transaction(conn):
        set_settings(
            conn,
            {"household": body.household, "language": body.language, "decimal": body.decimal,
             "decimal_both": body.decimal_both, "currency": body.currency},
        )
        for i, name in enumerate(n.strip() for n in body.members):
            if name:
                conn.execute("INSERT INTO members (name, color, sort) VALUES (?, ?, ?)", (name[:60], i % 8, i))
        conn.execute(
            "INSERT INTO members (name, color, is_shared, sort) VALUES (?, ?, 1, 0)",
            (body.shared_name.strip(), len(body.members) % 8),
        )
        if body.starter_categories:
            for kind, names in DEFAULT_CATEGORIES[lang].items():
                conn.executemany(
                    "INSERT INTO categories (name, kind, sort) VALUES (?, ?, ?)",
                    [(n, kind, i) for i, n in enumerate(names)],
                )
        if body.starter_accounts:
            conn.executemany(
                "INSERT INTO accounts (name, kind, color, sort) VALUES (?, ?, ?, ?)",
                [(n, k, i, i) for i, (n, k) in enumerate(DEFAULT_ACCOUNTS[lang])],
            )


class SettingsIn(BaseModel):
    household: str | None = Field(None, max_length=100)
    language: str | None = Field(None, max_length=10)
    decimal: Literal[",", ".", "either"] | None = None
    # With decimal 'either': a number with both comma and dot takes the last
    # one as the decimal separator ('last'), or is rejected ('invalid').
    decimal_both: Literal["last", "invalid"] | None = None
    # Keep decimals, round them off, or accept whole numbers only.
    decimals: Literal["keep", "nearest", "up", "down", "only"] | None = None
    # What a budget month is: the calendar month ('last'), or from the
    # previous month's last weekday, when the salary comes, to the day before
    # its own ('before_payday'). Month-end balances are read on its last day.
    balance_day: Literal["last", "before_payday"] | None = None
    currency: str | None = Field(None, max_length=3)


@app.put("/api/settings")
def update_settings(body: SettingsIn, request: Request, conn: sqlite3.Connection = Conn):
    if body.household is not None:
        # The budget's name is also what it's logged in with: rename both.
        name = body.household.strip()
        login = _login_name(name)
        server = db.open_server()
        try:
            if server.execute("SELECT 1 FROM budgets WHERE login = ? AND id != ?", (login, request.state.budget_id)).fetchone():
                raise AppError(409, "USERNAME_TAKEN", "that budget name is taken")
            server.execute("UPDATE budgets SET name = ?, login = ? WHERE id = ?", (name, login, request.state.budget_id))
        finally:
            server.close()
        body.household = name
    with db.transaction(conn):
        set_settings(conn, body.model_dump(exclude_none=True))
        if body.balance_day is not None:
            banking.regroup_transactions(conn)  # into their budget months the new way
        if body.decimals is not None or body.balance_day is not None:
            banking.update_month_balances(conn)  # balances from the bank, rounded or read the new way
    return get_settings(conn)


# --------------------------------------------------------------------------
# Members, categories, accounts


class MemberIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    color: int | None = Field(None, ge=0, le=7)
    archived: bool | None = None


class OrderIn(BaseModel):
    ids: list[int]


def _patch(conn, table: str, id: int, values: dict) -> dict:
    one(conn, f"SELECT id FROM {table} WHERE id = ?", (id,))
    if values:
        cols = ", ".join(f"{k} = ?" for k in values)
        conn.execute(f"UPDATE {table} SET {cols} WHERE id = ?", (*values.values(), id))
    return one(conn, f"SELECT * FROM {table} WHERE id = ?", (id,))


def _reorder(conn, table: str, ids: list[int]) -> None:
    with db.transaction(conn):
        conn.executemany(f"UPDATE {table} SET sort = ? WHERE id = ?", list(enumerate(ids)))


@app.post("/api/members")
def create_member(body: MemberIn, conn: sqlite3.Connection = Conn):
    if not body.name:
        raise AppError(422, "INVALID", "name is required")
    count = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    color = body.color if body.color is not None else count % 8
    cur = conn.execute(
        "INSERT INTO members (name, color, sort) VALUES (?, ?, ?)", (body.name, color, next_sort(conn, "members"))
    )
    return one(conn, "SELECT * FROM members WHERE id = ?", (cur.lastrowid,))


@app.patch("/api/members/{id}")
def update_member(id: int, body: MemberIn, conn: sqlite3.Connection = Conn):
    return _patch(conn, "members", id, body.model_dump(exclude_none=True))


@app.delete("/api/members/{id}")
def delete_member(id: int, conn: sqlite3.Connection = Conn):
    member = one(conn, "SELECT * FROM members WHERE id = ?", (id,))
    if member["is_shared"]:
        raise AppError(409, "SHARED_CANNOT_DELETE", "the shared household budget cannot be deleted")
    if conn.execute("SELECT 1 FROM items WHERE member_id = ?", (id,)).fetchone():
        raise AppError(409, "MEMBER_HAS_ITEMS", "has budget items; archive instead")
    conn.execute("DELETE FROM members WHERE id = ?", (id,))
    return {"ok": True}


@app.post("/api/members/order")
def order_members(body: OrderIn, conn: sqlite3.Connection = Conn):
    _reorder(conn, "members", body.ids)
    return {"ok": True}


class CategoryIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    kind: Kind | None = None


@app.post("/api/categories")
def create_category(body: CategoryIn, conn: sqlite3.Connection = Conn):
    if not body.name or not body.kind:
        raise AppError(422, "INVALID", "name and kind are required")
    cur = conn.execute(
        "INSERT INTO categories (name, kind, sort) VALUES (?, ?, ?)",
        (body.name, body.kind, next_sort(conn, "categories")),
    )
    return one(conn, "SELECT * FROM categories WHERE id = ?", (cur.lastrowid,))


@app.patch("/api/categories/{id}")
def update_category(id: int, body: CategoryIn, conn: sqlite3.Connection = Conn):
    return _patch(conn, "categories", id, body.model_dump(exclude_none=True, exclude={"kind"}))


@app.delete("/api/categories/{id}")
def delete_category(id: int, conn: sqlite3.Connection = Conn):
    conn.execute("DELETE FROM categories WHERE id = ?", (id,))
    return {"ok": True}


@app.post("/api/categories/order")
def order_categories(body: OrderIn, conn: sqlite3.Connection = Conn):
    _reorder(conn, "categories", body.ids)
    return {"ok": True}


class AccountIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    # main: the one budget account everything flows in and out of; savings;
    # expense: money moved there is spent from there.
    kind: Literal["main", "savings", "expense"] | None = None
    color: int | None = Field(None, ge=0, le=7)
    archived: bool | None = None
    in_overview: bool | None = None


def _one_main(conn, kind: str | None, id: int | None = None) -> None:
    """There is one budget account: making another one it turns the old one
    into an expense account."""
    if kind == "main":
        conn.execute("UPDATE accounts SET kind = 'expense', in_overview = 0 WHERE kind = 'main' AND id IS NOT ?", (id,))


def _account_values(body: AccountIn) -> dict:
    values = body.model_dump(exclude_none=True)
    if body.kind == "expense" and body.in_overview is None:
        values["in_overview"] = False  # expense accounts stay off the overview unless chosen
    elif body.kind in ("main", "savings") and body.in_overview is None:
        values["in_overview"] = True
    return values


@app.post("/api/accounts")
def create_account(body: AccountIn, conn: sqlite3.Connection = Conn):
    if not body.name or not body.kind:
        raise AppError(422, "INVALID", "name and kind are required")
    count = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
    values = _account_values(body)
    with db.transaction(conn):
        _one_main(conn, body.kind)
        cur = conn.execute(
            "INSERT INTO accounts (name, kind, color, sort, in_overview) VALUES (?, ?, ?, ?, ?)",
            (body.name, body.kind, body.color if body.color is not None else count % 8, next_sort(conn, "accounts"),
             int(values["in_overview"])),
        )
    return one(conn, "SELECT * FROM accounts WHERE id = ?", (cur.lastrowid,))


@app.patch("/api/accounts/{id}")
def update_account(id: int, body: AccountIn, conn: sqlite3.Connection = Conn):
    with db.transaction(conn):
        _one_main(conn, body.kind, id)
        return _patch(conn, "accounts", id, _account_values(body))


@app.delete("/api/accounts/{id}")
def delete_account(id: int, conn: sqlite3.Connection = Conn):
    if conn.execute("SELECT 1 FROM bank_accounts WHERE account_id = ?", (id,)).fetchone():
        raise AppError(409, "BANK_ACCOUNT", "this account comes from the bank; remove it there or in Enable Banking")
    conn.execute("DELETE FROM accounts WHERE id = ?", (id,))
    return {"ok": True}


@app.post("/api/accounts/order")
def order_accounts(body: OrderIn, conn: sqlite3.Connection = Conn):
    _reorder(conn, "accounts", body.ids)
    return {"ok": True}


class BalanceIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    month: int = Field(ge=1, le=12)
    amount: float | None


@app.put("/api/accounts/{id}/balance")
def set_balance(id: int, body: BalanceIn, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM accounts WHERE id = ?", (id,))
    if body.amount is None:
        conn.execute(
            "DELETE FROM account_balances WHERE account_id = ? AND year = ? AND month = ?", (id, body.year, body.month)
        )
        # Clearing a typed-in balance lets the bank's come back.
        banking.update_month_balances(conn)
    else:
        conn.execute(
            "INSERT INTO account_balances (account_id, year, month, cents, source) VALUES (?, ?, ?, ?, 'manual') "
            "ON CONFLICT (account_id, year, month) DO UPDATE SET cents = excluded.cents, source = 'manual'",
            (id, body.year, body.month, amount_cents(conn, body.amount)),
        )
    return {"ok": True}


@app.get("/api/accounts/{id}/history")
def account_history(id: int, year: int, conn: sqlite3.Connection = Conn):
    """The balance after each bank transaction in year (for a bank-linked account)."""
    return banking.balance_history(conn, id, year)


@app.get("/api/accounts/{id}/balances")
def list_balances(id: int, conn: sqlite3.Connection = Conn):
    return [
        {"year": r["year"], "month": r["month"], "amount": db.from_cents(r["cents"]), "source": r["source"]}
        for r in conn.execute(
            "SELECT * FROM account_balances WHERE account_id = ? ORDER BY year, month", (id,)
        )
    ]


# --------------------------------------------------------------------------
# Budget items


@app.get("/api/years/{year}/items")
def year_items(year: int, conn: sqlite3.Connection = Conn):
    ids = calc.visible_item_ids(conn, year)
    if not ids:
        return []
    amounts = calc.year_amounts(conn, year)
    prev = calc.year_amounts(conn, year - 1)
    actual = banking.actuals(conn, year)
    unreadable = unreadable_cells(conn, year)
    items = rows(
        conn.execute(
            f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))}) ORDER BY sort, id", ids
        )
    )
    return [
        item_out(i, amounts.get(i["id"], [None] * 12), prev.get(i["id"], [None] * 12), actual.get(i["id"]), unreadable.get(i["id"]))
        for i in items
    ]


class ItemIn(BaseModel):
    member_id: int | None = None
    kind: Kind | None = None
    name: str | None = Field(None, min_length=1, max_length=200)
    category_id: int | None = None
    account_id: int | None = None
    fixed: bool | None = None
    note: str | None = Field(None, max_length=2000)


class NewItemIn(ItemIn):
    member_id: int
    kind: Kind
    name: str = Field(min_length=1, max_length=200)
    year: int = Field(ge=1900, le=2200)
    amounts: list[float | None] | None = None


def _get_item(conn, id: int, year: int) -> dict:
    item = one(conn, "SELECT * FROM items WHERE id = ?", (id,))
    amounts = calc.year_amounts(conn, year).get(id, [None] * 12)
    prev = calc.year_amounts(conn, year - 1).get(id, [None] * 12)
    return item_out(item, amounts, prev, banking.actuals(conn, year).get(id), unreadable_cells(conn, year).get(id))


@app.post("/api/items")
def create_item(body: NewItemIn, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM members WHERE id = ?", (body.member_id,))
    with db.transaction(conn):
        cur = conn.execute(
            "INSERT INTO items (member_id, kind, name, category_id, account_id, fixed, note, sort) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.member_id, body.kind, body.name.strip(), body.category_id, body.account_id,
                int(bool(body.fixed)), body.note or "", next_sort(conn, "items"),
            ),
        )
        set_amounts(conn, cur.lastrowid, body.year, cents_list(conn, body.amounts or [None] * 12))
    return _get_item(conn, cur.lastrowid, body.year)


@app.patch("/api/items/{id}")
def update_item(id: int, body: ItemIn, year: int, conn: sqlite3.Connection = Conn):
    values = body.model_dump(exclude_unset=True)
    if "fixed" in values:
        values["fixed"] = int(bool(values["fixed"]))
    for required in ("member_id", "kind", "name", "fixed", "note"):
        if required in values and values[required] is None:
            raise AppError(422, "INVALID", f"{required} cannot be empty")
    _patch(conn, "items", id, values)
    return _get_item(conn, id, year)


@app.delete("/api/items/{id}")
def delete_item(id: int, year: int | None = None, conn: sqlite3.Connection = Conn):
    """With a year, takes the item out of that year's budget only."""
    one(conn, "SELECT id FROM items WHERE id = ?", (id,))
    with db.transaction(conn):
        if year is None:
            conn.execute("DELETE FROM items WHERE id = ?", (id,))
        else:
            conn.execute("DELETE FROM amounts WHERE item_id = ? AND year = ?", (id, year))
            conn.execute("DELETE FROM item_years WHERE item_id = ? AND year = ?", (id, year))
            if not conn.execute(
                "SELECT 1 FROM item_years WHERE item_id = ? UNION SELECT 1 FROM amounts WHERE item_id = ?", (id, id)
            ).fetchone():
                conn.execute("DELETE FROM items WHERE id = ?", (id,))
    return {"ok": True}


class AmountsIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    amounts: list[float | None]


@app.put("/api/items/{id}/amounts")
def put_amounts(id: int, body: AmountsIn, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM items WHERE id = ?", (id,))
    values = cents_list(conn, body.amounts)
    with db.transaction(conn):
        set_amounts(conn, id, body.year, values)
        # A month with an amount now no longer has an unreadable cell.
        conn.executemany(
            "DELETE FROM unreadable WHERE item_id = ? AND year = ? AND month = ?",
            [(id, body.year, m + 1) for m, v in enumerate(values) if v is not None],
        )
    return _get_item(conn, id, body.year)


class AmountIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    month: int = Field(ge=1, le=12)
    amount: float | None


@app.put("/api/items/{id}/amount")
def put_amount(id: int, body: AmountIn, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM items WHERE id = ?", (id,))
    with db.transaction(conn):
        # Any amount typed in, or a deliberate clear, settles an unreadable cell.
        conn.execute("DELETE FROM unreadable WHERE item_id = ? AND year = ? AND month = ?", (id, body.year, body.month))
        if body.amount is None:
            conn.execute(
                "DELETE FROM amounts WHERE item_id = ? AND year = ? AND month = ?", (id, body.year, body.month)
            )
        else:
            conn.execute(
                "INSERT INTO amounts (item_id, year, month, cents) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (item_id, year, month) DO UPDATE SET cents = excluded.cents",
                (id, body.year, body.month, amount_cents(conn, body.amount)),
            )
        conn.execute("INSERT OR IGNORE INTO item_years (item_id, year) VALUES (?, ?)", (id, body.year))
    return {"ok": True}


@app.post("/api/items/order")
def order_items(body: OrderIn, conn: sqlite3.Connection = Conn):
    _reorder(conn, "items", body.ids)
    return {"ok": True}


class CopyYearIn(BaseModel):
    from_year: int
    amounts: bool = True


@app.post("/api/years/{year}/copy")
def copy_year(year: int, body: CopyYearIn, conn: sqlite3.Connection = Conn):
    """Start a year from another: every item of from_year that is not in this
    year yet is added, with its amounts unless amounts is false."""
    source = set(calc.visible_item_ids(conn, body.from_year))
    present = set(calc.visible_item_ids(conn, year))
    todo = sorted(source - present)
    src_amounts = calc.year_amounts(conn, body.from_year)
    with db.transaction(conn):
        for item_id in todo:
            values = src_amounts.get(item_id, [None] * 12) if body.amounts else [None] * 12
            set_amounts(conn, item_id, year, values)
    return {"copied": len(todo)}


@app.delete("/api/years/{year}")
def delete_year(year: int, conn: sqlite3.Connection = Conn):
    """Delete a year's budget: its amounts, typed-in balances and import gaps.
    Items only in that year go; items of other years stay. The bank's
    transactions stay too, but are taken off the items, to be reconciled
    again if the year is rebuilt."""
    with db.transaction(conn):
        conn.execute("UPDATE bank_transactions SET item_id = NULL WHERE year = ?", (year,))
        for table in ("amounts", "item_years", "unreadable"):
            conn.execute(f"DELETE FROM {table} WHERE year = ?", (year,))
        conn.execute("DELETE FROM account_balances WHERE year = ? AND source = 'manual'", (year,))
        conn.execute(
            "DELETE FROM items WHERE id NOT IN (SELECT item_id FROM item_years) AND id NOT IN (SELECT item_id FROM amounts)"
        )
    return state(conn)


# --------------------------------------------------------------------------
# Statistics


def _money_summary(s: dict) -> dict:
    for key in ("income", "expense", "net", "cumulative", "savings", "fixed"):
        s[key] = money_list(s[key])
    for m in s["members"]:
        m["income"] = money_list(m["income"])
        m["expense"] = money_list(m["expense"])
    for c in s["categories"]:
        c["months"] = money_list(c["months"])
        c["total"] = db.from_cents(c["total"])
    for a in s["accounts"]:
        a["balances"] = money_list(a["balances"])
    for t in s["top_expenses"]:
        t["total"] = db.from_cents(t["total"])
    return s


@app.get("/api/summary/{year}")
def summary(year: int, conn: sqlite3.Connection = Conn):
    return _money_summary(calc.summary(conn, year))


@app.get("/api/trends")
def trends(conn: sqlite3.Connection = Conn):
    out = calc.trends(conn)
    for y in out:
        for key in ("income", "expense", "savings", "net"):
            y[key] = db.from_cents(y[key])
        y["accounts"] = {k: db.from_cents(v) for k, v in y["accounts"].items()}
        for m in y["members"]:
            m["income"] = db.from_cents(m["income"])
            m["expense"] = db.from_cents(m["expense"])
    return out


# --------------------------------------------------------------------------
# Backup, export and import

TABLES = [
    "settings", "members", "categories", "accounts", "account_balances", "items", "item_years", "amounts",
    "bank_sessions", "bank_accounts", "bank_transactions", "bank_rules", "bank_not_item", "unreadable",
]


@app.get("/api/export")
def export(conn: sqlite3.Connection = Conn):
    data = {"format": "sparegrisen", "schema": len(db.MIGRATIONS), "exported": int(time.time())}
    for t in TABLES:
        data[t] = rows(conn.execute(f"SELECT * FROM {t}"))
    stamp = time.strftime("%Y-%m-%d")
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="sparegrisen-backup-{stamp}.json"'})


@app.post("/api/restore")
async def restore(request: Request, conn: sqlite3.Connection = Conn):
    try:
        data = json.loads(await request.body())
    except ValueError:
        raise AppError(422, "NOT_JSON", "not a JSON file")
    if not isinstance(data, dict) or data.get("format") not in backup.FORMATS:
        raise AppError(422, "NOT_BACKUP", "not a Sparegrisen backup")
    if data.get("schema", 0) > len(db.MIGRATIONS):
        raise AppError(422, "BACKUP_TOO_NEW", "this backup is from a newer version of Sparegrisen")
    data = backup.upgrade(data, len(db.MIGRATIONS))
    try:
        with db.transaction(conn):
            for t in reversed(TABLES):
                conn.execute(f"DELETE FROM {t}")
            for t in TABLES:
                columns = {r["name"] for r in conn.execute(f"PRAGMA table_info({t})")}
                for row in data.get(t, []):
                    row = {k: v for k, v in row.items() if k in columns}
                    if row:
                        conn.execute(
                            f"INSERT INTO {t} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                            list(row.values()),
                        )
    except sqlite3.Error as e:
        raise AppError(422, "RESTORE_FAILED", f"backup could not be restored: {e}")
    return {"ok": True}


@app.get("/api/export/{year}.xlsx")
def export_xlsx(year: int, group: Literal["auto", "category", "member"] = "auto", conn: sqlite3.Connection = Conn):
    """The year's budget as an Excel workbook."""
    data, filename = export_workbook.build(conn, year, group)
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"budget-{year}.xlsx\"; filename*=UTF-8''{quote(filename)}"},
    )


@app.post("/api/import/preview")
async def import_preview(
    file: UploadFile = File(...),
    decimal: Literal[",", ".", "either"] = Form(","),
    both: Literal["last", "invalid"] = Form("last"),
    conn: sqlite3.Connection = Conn,
):
    """Read a spreadsheet. decimal: the decimal separator of amounts written as text.
    Decimals are rounded off, or refused, as the budget's settings say."""
    data = await file.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise AppError(413, "FILE_TOO_LARGE", "file is too large")
    try:
        return {"sheets": importer.read_file(file.filename or "", data, decimal, both, db.decimals_mode(conn))}
    except Exception as e:  # openpyxl raises many different errors for bad files
        raise AppError(422, "FILE_UNREADABLE", f"could not read the file: {e}")


class ImportRow(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    amounts: list[float | None]
    # Cells that couldn't be read as amounts (month -> text): remembered so
    # the gap shows until it's fixed.
    invalid: dict[int, str] = {}


class ImportSheet(BaseModel):
    member_id: int
    kind: Kind
    rows: list[ImportRow]


class ImportIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    sheets: list[ImportSheet]
    # 1000 when the spreadsheet's amounts are in thousands (27.8 meaning 27,800).
    scale: Literal[1, 1000] = 1


@app.post("/api/import/commit")
def import_commit(body: ImportIn, conn: sqlite3.Connection = Conn):
    """Add the rows to the year. A row whose name matches an existing item of
    the same person and type updates that item, so importing one sheet per
    year builds up one history per item instead of duplicates."""
    created = updated = 0
    with db.transaction(conn):
        for sheet in body.sheets:
            one(conn, "SELECT id FROM members WHERE id = ?", (sheet.member_id,))
            for row in sheet.rows:
                name = row.name.strip()
                existing = conn.execute(
                    "SELECT id FROM items WHERE member_id = ? AND kind = ? AND lower(trim(name)) = lower(?) "
                    "ORDER BY id LIMIT 1",
                    (sheet.member_id, sheet.kind, name),
                ).fetchone()
                if existing:
                    item_id = existing[0]
                    updated += 1
                else:
                    # "Savings" moving money to the account called "Savings".
                    account = conn.execute(
                        "SELECT id FROM accounts WHERE kind = 'savings' AND lower(trim(name)) = lower(?)", (name,)
                    ).fetchone()
                    item_id = conn.execute(
                        "INSERT INTO items (member_id, kind, name, account_id, sort) VALUES (?, ?, ?, ?, ?)",
                        (sheet.member_id, sheet.kind, name, account[0] if account else None, next_sort(conn, "items")),
                    ).lastrowid
                    created += 1
                amounts = [None if v is None else v * body.scale for v in row.amounts]
                set_amounts(conn, item_id, body.year, cents_list(conn, amounts))
                conn.execute("DELETE FROM unreadable WHERE item_id = ? AND year = ?", (item_id, body.year))
                conn.executemany(
                    "INSERT INTO unreadable (item_id, year, month, raw) VALUES (?, ?, ?, ?)",
                    [(item_id, body.year, m, raw) for m, raw in row.invalid.items() if 1 <= m <= 12],
                )
    suspicious = [f for f in checks.find(conn, _dismissed(conn))["findings"] if f["year"] == body.year]
    return {"created": created, "updated": updated, "suspicious": len(suspicious)}


# --------------------------------------------------------------------------
# Checking the numbers


def _dismissed(conn) -> set[str]:
    return set(get_settings(conn).get("checks_dismissed", []))


@app.get("/api/checks")
def run_checks(conn: sqlite3.Connection = Conn):
    """Amounts that look 10, 100 or 1000 times off."""
    return checks.find(conn, _dismissed(conn))


class CheckPlace(BaseModel):
    year: int = Field(ge=1900, le=2200)
    months: list[int] = Field(min_length=1, max_length=12)


class CheckFixIn(BaseModel):
    item_id: int | None = None
    account_id: int | None = None
    where: list[CheckPlace] = Field(min_length=1)
    multiply: float | None = Field(None, gt=0, le=10000)
    use_bank: bool = False
    round: Literal["nearest", "up", "down"] | None = None


@app.post("/api/checks/fix")
def fix_check(body: CheckFixIn, conn: sqlite3.Connection = Conn):
    if body.item_id is None and body.account_id is None:
        raise AppError(422, "INVALID", "item_id or account_id is required")
    with db.transaction(conn):
        checks.fix(conn, item_id=body.item_id, account_id=body.account_id, where=[w.model_dump() for w in body.where],
                   multiply=body.multiply, use_bank=body.use_bank, round_to=body.round)
    return checks.find(conn, _dismissed(conn))


class CheckDismissIn(BaseModel):
    id: str = Field(max_length=200)
    # For an unreadable cell: which ones to forget.
    item_id: int | None = None
    where: list[CheckPlace] = []


@app.post("/api/checks/dismiss")
def dismiss_check(body: CheckDismissIn, conn: sqlite3.Connection = Conn):
    """'This amount is right' (don't report it again), or for an unreadable
    cell 'ignore it' (the month stays empty)."""
    with db.transaction(conn):
        if body.id.startswith("unreadable:") and body.item_id is not None:
            for w in body.where:
                conn.executemany(
                    "DELETE FROM unreadable WHERE item_id = ? AND year = ? AND month = ?",
                    [(body.item_id, w.year, m) for m in w.months],
                )
        else:
            set_settings(conn, {"checks_dismissed": sorted(_dismissed(conn) | {body.id})})
    return checks.find(conn, _dismissed(conn))


@app.post("/api/checks/reset")
def reset_checks(conn: sqlite3.Connection = Conn):
    with db.transaction(conn):
        set_settings(conn, {"checks_dismissed": []})
    return checks.find(conn, set())


# --------------------------------------------------------------------------
# Bank sync (Enable Banking)


def _redirect_url(request: Request) -> str:
    base = getenv("PUBLIC_URL") or str(request.base_url)
    return base.rstrip("/") + "/api/bank/callback"


def _psu_headers(request: Request) -> dict:
    """What we know about the person pressing Sync, so the bank counts it as
    them looking rather than an automatic fetch."""
    h = request.headers
    out = {
        "Psu-Ip-Address": request.client.host if request.client else "",
        "Psu-User-Agent": h.get("user-agent", ""),
        "Psu-Referer": h.get("referer", ""),
        "Psu-Accept": h.get("accept", ""),
        "Psu-Accept-Charset": h.get("accept-charset", ""),
        "Psu-Accept-Encoding": h.get("accept-encoding", ""),
        "Psu-Accept-Language": h.get("accept-language", ""),
    }
    return {k: v for k, v in out.items() if v}


@app.get("/api/bank/status")
def bank_status(request: Request, conn: sqlite3.Connection = Conn):
    bdir = budget_dir(request)
    config = banking.get_config(bdir)
    sessions = rows(conn.execute("SELECT id, aspsp_name, aspsp_country, valid_until, status, last_sync, last_error FROM bank_sessions ORDER BY created"))
    accounts = rows(conn.execute(
        "SELECT b.id, b.session_id, b.name, b.iban, b.currency, b.account_id, b.balance_cents, b.balance_date, "
        f"{banking.IN_BUDGET} AS budget, "
        "b.history_from, b.synced_to, s.aspsp_name AS bank FROM bank_accounts b LEFT JOIN bank_sessions s ON s.id = b.session_id ORDER BY b.id"
    ))
    for a in accounts:
        a["balance"] = db.from_cents(a.pop("balance_cents"))
        a["budget"] = bool(a["budget"])  # the budget account's: its transactions are reconciled
    rules = rows(conn.execute(
        "SELECT r.*, i.name AS item_name, i.kind AS item_kind FROM bank_rules r LEFT JOIN items i ON i.id = r.item_id ORDER BY r.pattern"
    ))
    for r in rules:
        r["ignore"] = bool(r["ignore"])
        r["amount"] = db.from_cents(r.pop("amount_cents"))
    unsorted = conn.execute(
        "SELECT t.year, t.month, COUNT(*) AS n FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id "
        f"WHERE {banking.IN_BUDGET} AND t.item_id IS NULL AND t.ignored = 0 GROUP BY t.year, t.month"
    ).fetchall()
    return {
        "configured": bool(config),
        "app_id": config[0] if config else None,
        # The certificate Sparegrisen made for Enable Banking: in use, or waiting to be registered.
        "certificate": banking.current_certificate(bdir),
        "pending_certificate": banking.pending_certificate(bdir),
        "redirect_url": _redirect_url(request),
        "sync_hours": banking.SYNC_HOURS,
        "sessions": sessions,
        "accounts": accounts,
        "rules": rules,
        "unsorted": {f"{r['year']}-{r['month']}": r["n"] for r in unsorted},
        "reconciled": banking.reconciled_months(conn),
    }


@app.post("/api/bank/certificate")
def bank_certificate(request: Request):
    """A key pair for registering Sparegrisen with Enable Banking; returns the certificate to paste there."""
    return {"certificate": banking.new_certificate(budget_dir(request))}


class BankConfigIn(BaseModel):
    app_id: str = Field(min_length=1, max_length=100)
    # Only when bringing your own key; otherwise the one from /api/bank/certificate is used.
    private_key: str | None = Field(None, max_length=20000)


@app.put("/api/bank/config")
def bank_config(body: BankConfigIn, request: Request):
    try:
        banking.save_config(budget_dir(request), body.app_id, body.private_key)
    except banking.ConfigError as e:
        raise AppError(422, e.code, str(e))
    ok, message = banking.test_connection(budget_dir(request))
    return {"ok": True, "test": {"ok": ok, "message": message}}


@app.post("/api/bank/test")
def bank_test(request: Request):
    ok, message = banking.test_connection(budget_dir(request))
    return {"ok": ok, "message": message}


@app.delete("/api/bank/config")
def bank_config_delete(request: Request):
    banking.delete_config(budget_dir(request))
    return {"ok": True}


_aspsp_cache: dict[str, tuple[float, list]] = {}


@app.get("/api/bank/aspsps")
def bank_aspsps(request: Request, country: str = "DK"):
    country = country.upper()[:2]
    cached = _aspsp_cache.get(country)
    if not cached or cached[0] < time.time() - 86400:
        banks = [
            {"name": a["name"], "country": a["country"], "logo": a.get("logo"), "beta": a.get("beta", False)}
            for a in banking.client(budget_dir(request)).aspsps(country)
        ]
        cached = _aspsp_cache[country] = (time.time(), sorted(banks, key=lambda a: a["name"].lower()))
    return cached[1]


class BankConnectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    country: str = Field(min_length=2, max_length=2)


@app.post("/api/bank/connect")
def bank_connect(body: BankConnectIn, request: Request, conn: sqlite3.Connection = Conn):
    return {"url": banking.connect_start(conn, budget_dir(request), body.name, body.country.upper(), _redirect_url(request))}


@app.get("/api/bank/callback")
def bank_callback(request: Request, state: str = "", code: str = "", error: str = "", error_description: str = "", conn: sqlite3.Connection = Conn):
    """Where the bank sends the browser back to after logging in."""
    if error or not code:
        message = error_description or error or "no code from the bank"
        return RedirectResponse(f"/#/settings?bank=error&message={quote(message)}", status_code=303)
    try:
        banking.connect_finish(conn, budget_dir(request), code, state)
        result = banking.sync(conn, budget_dir(request), _psu_headers(request))
        return RedirectResponse(f"/#/settings?bank=connected&new={result['new']}", status_code=303)
    except banking.BankError as e:
        return RedirectResponse(f"/#/settings?bank=error&code={quote(e.code)}&message={quote(str(e))}", status_code=303)


@app.post("/api/bank/sync")
def bank_sync(request: Request, conn: sqlite3.Connection = Conn):
    return banking.sync(conn, budget_dir(request), _psu_headers(request))


@app.delete("/api/bank/sessions/{id}")
def bank_disconnect(id: str, request: Request, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM bank_sessions WHERE id = ?", (id,))
    banking.disconnect(conn, budget_dir(request), id)
    return {"ok": True}


@app.get("/api/bank/transactions")
def bank_transactions(year: int, month: int, conn: sqlite3.Connection = Conn):
    return banking.month_transactions(conn, year, month)


class AssignIn(BaseModel):
    item_id: int | None = None
    ignored: bool = False
    # Also sort future (and other unsorted) transactions containing this text the same way.
    rule: str | None = Field(None, max_length=200)
    # ... but only those of the same amount as this one.
    rule_amount: bool = False
    # Taking it off an item normally means "not that item" (no suggestions or
    # rules put it back). An undo right after putting it on doesn't.
    remember: bool = True


@app.put("/api/bank/transactions/{id}")
def bank_assign(id: int, body: AssignIn, conn: sqlite3.Connection = Conn):
    tx = one(conn, "SELECT * FROM bank_transactions WHERE id = ?", (id,))
    if body.item_id is not None:
        one(conn, "SELECT id FROM items WHERE id = ?", (body.item_id,))
    sorted_count = 0
    with db.transaction(conn):
        if tx["item_id"] is not None and tx["item_id"] != body.item_id and body.remember:
            banking.not_item(conn, id, tx["item_id"])  # taken off an item: don't let a rule put it back
        banking._assign(conn, id, body.item_id, body.ignored and body.item_id is None, tx["year"])
        rule_id = None
        if body.rule and body.rule.strip() and (body.item_id is not None or body.ignored):
            rule_id = conn.execute(
                "INSERT INTO bank_rules (pattern, item_id, ignore, amount_cents) VALUES (?, ?, ?, ?)",
                (body.rule.strip(), body.item_id, int(body.item_id is None), abs(tx["cents"]) if body.rule_amount else None),
            ).lastrowid
            sorted_count = banking.apply_rules(conn)
    # rule_id: for an undo, which deletes the rule again.
    return {"ok": True, "sorted": sorted_count, "rule_id": rule_id}


class MoveIn(BaseModel):
    # The budget month to put it in; leave both out to put it back in its own.
    year: int | None = Field(None, ge=1900, le=2200)
    month: int | None = Field(None, ge=1, le=12)


@app.put("/api/bank/transactions/{id}/month")
def bank_move(id: int, body: MoveIn, conn: sqlite3.Connection = Conn):
    """A transaction that belongs to another budget month than it was booked in."""
    one(conn, "SELECT id FROM bank_transactions WHERE id = ?", (id,))
    with db.transaction(conn):
        banking.move_transaction(conn, id, body.year, body.month)
    return {"ok": True}


@app.post("/api/bank/transactions/{id}/not/{item_id}")
def bank_not_item(id: int, item_id: int, conn: sqlite3.Connection = Conn):
    """A suggestion turned down: this transaction is not that item."""
    one(conn, "SELECT id FROM bank_transactions WHERE id = ?", (id,))
    with db.transaction(conn):
        banking.not_item(conn, id, item_id)
    return {"ok": True}


@app.delete("/api/bank/transactions/{id}/not/{item_id}")
def bank_not_item_undo(id: int, item_id: int, conn: sqlite3.Connection = Conn):
    """Undo turning a suggestion down."""
    conn.execute("DELETE FROM bank_not_item WHERE transaction_id = ? AND item_id = ?", (id, item_id))
    return {"ok": True}


@app.delete("/api/bank/rules/{id}")
def bank_rule_delete(id: int, conn: sqlite3.Connection = Conn):
    conn.execute("DELETE FROM bank_rules WHERE id = ?", (id,))
    return {"ok": True}


# --------------------------------------------------------------------------
# The web app itself. Mounted last so it never shadows the API.

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
