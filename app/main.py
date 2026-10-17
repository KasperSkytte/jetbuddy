import csv
import io
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, auth, calc, db, importer

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
Kind = Literal["income", "expense"]
MAX_IMPORT_BYTES = 10 * 1024 * 1024



@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = db.connect()
    db.migrate(conn)
    conn.close()
    yield


app = FastAPI(
    title="Nestegg", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json"
)


def get_conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


Conn = Depends(get_conn)


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    open_paths = ("/api/session", "/api/login", "/api/logout", "/api/health")
    if auth.password() and path.startswith("/api/") and path not in open_paths:
        if not auth.valid_token(request.cookies.get(auth.COOKIE)):
            return JSONResponse({"detail": "login required"}, status_code=401)
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
        raise HTTPException(404, "not found")
    return dict(r)


def cents_list(values: list[float | None]) -> list[int | None]:
    if len(values) != 12:
        raise HTTPException(422, "amounts must have 12 values")
    return [db.to_cents(v) for v in values]


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


def item_out(item: dict, amounts: list[int | None], prev: list[int | None]) -> dict:
    return {
        **item,
        "fixed": bool(item["fixed"]),
        "amounts": money_list(amounts),
        "prev": money_list(prev),
    }


# --------------------------------------------------------------------------
# Session


class LoginIn(BaseModel):
    password: str


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/api/session")
def session(request: Request):
    required = bool(auth.password())
    return {
        "auth_required": required,
        "logged_in": not required or auth.valid_token(request.cookies.get(auth.COOKIE)),
    }


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    if not auth.check_password(body.password):
        time.sleep(1)  # slows down guessing
        raise HTTPException(401, "wrong password")
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        auth.COOKIE,
        auth.make_token(),
        max_age=auth.SESSION_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure,
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
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
    locale: str = "en-US"
    currency: str = "USD"
    members: list[str] = Field(min_length=1, max_length=20)
    shared_name: str = Field("Shared", min_length=1, max_length=60)
    starter_categories: bool = True
    starter_accounts: bool = True


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
    return {
        "version": __version__,
        "setup_done": bool(members),
        "settings": get_settings(conn),
        "members": members,
        "categories": rows(conn.execute("SELECT * FROM categories ORDER BY kind, sort, id")),
        "accounts": accounts,
        "years": years,
    }


@app.post("/api/setup")
def setup(body: SetupIn, conn: sqlite3.Connection = Conn):
    if conn.execute("SELECT 1 FROM members").fetchone():
        raise HTTPException(409, "already set up")
    lang = body.language if body.language in DEFAULT_CATEGORIES else "en"
    with db.transaction(conn):
        set_settings(
            conn,
            {"household": body.household, "language": body.language, "locale": body.locale, "currency": body.currency},
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
    return state(conn)


class SettingsIn(BaseModel):
    household: str | None = Field(None, max_length=100)
    language: str | None = Field(None, max_length=10)
    locale: str | None = Field(None, max_length=20)
    currency: str | None = Field(None, max_length=3)


@app.put("/api/settings")
def update_settings(body: SettingsIn, conn: sqlite3.Connection = Conn):
    with db.transaction(conn):
        set_settings(conn, body.model_dump(exclude_none=True))
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
        raise HTTPException(422, "name is required")
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
        raise HTTPException(409, "the shared household budget cannot be deleted")
    if conn.execute("SELECT 1 FROM items WHERE member_id = ?", (id,)).fetchone():
        raise HTTPException(409, "has budget items; archive instead")
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
        raise HTTPException(422, "name and kind are required")
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
    kind: Literal["main", "savings"] | None = None
    color: int | None = Field(None, ge=0, le=7)
    archived: bool | None = None


def _check_one_main(conn, kind: str | None, id: int | None = None) -> None:
    if kind == "main":
        other = conn.execute("SELECT id FROM accounts WHERE kind = 'main' AND id IS NOT ?", (id,)).fetchone()
        if other:
            raise HTTPException(409, "there can only be one main account")


@app.post("/api/accounts")
def create_account(body: AccountIn, conn: sqlite3.Connection = Conn):
    if not body.name or not body.kind:
        raise HTTPException(422, "name and kind are required")
    _check_one_main(conn, body.kind)
    count = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
    cur = conn.execute(
        "INSERT INTO accounts (name, kind, color, sort) VALUES (?, ?, ?, ?)",
        (body.name, body.kind, body.color if body.color is not None else count % 8, next_sort(conn, "accounts")),
    )
    return one(conn, "SELECT * FROM accounts WHERE id = ?", (cur.lastrowid,))


@app.patch("/api/accounts/{id}")
def update_account(id: int, body: AccountIn, conn: sqlite3.Connection = Conn):
    _check_one_main(conn, body.kind, id)
    return _patch(conn, "accounts", id, body.model_dump(exclude_none=True))


@app.delete("/api/accounts/{id}")
def delete_account(id: int, conn: sqlite3.Connection = Conn):
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
    else:
        conn.execute(
            "INSERT INTO account_balances (account_id, year, month, cents) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (account_id, year, month) DO UPDATE SET cents = excluded.cents",
            (id, body.year, body.month, db.to_cents(body.amount)),
        )
    return {"ok": True}


@app.get("/api/accounts/{id}/balances")
def list_balances(id: int, conn: sqlite3.Connection = Conn):
    return [
        {"year": r["year"], "month": r["month"], "amount": db.from_cents(r["cents"])}
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
    items = rows(
        conn.execute(
            f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))}) ORDER BY sort, id", ids
        )
    )
    return [item_out(i, amounts.get(i["id"], [None] * 12), prev.get(i["id"], [None] * 12)) for i in items]


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
    return item_out(item, amounts, prev)


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
        set_amounts(conn, cur.lastrowid, body.year, cents_list(body.amounts or [None] * 12))
    return _get_item(conn, cur.lastrowid, body.year)


@app.patch("/api/items/{id}")
def update_item(id: int, body: ItemIn, year: int, conn: sqlite3.Connection = Conn):
    values = body.model_dump(exclude_unset=True)
    if "fixed" in values:
        values["fixed"] = int(bool(values["fixed"]))
    for required in ("member_id", "kind", "name", "fixed", "note"):
        if required in values and values[required] is None:
            raise HTTPException(422, f"{required} cannot be empty")
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
    with db.transaction(conn):
        set_amounts(conn, id, body.year, cents_list(body.amounts))
    return _get_item(conn, id, body.year)


class AmountIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    month: int = Field(ge=1, le=12)
    amount: float | None


@app.put("/api/items/{id}/amount")
def put_amount(id: int, body: AmountIn, conn: sqlite3.Connection = Conn):
    one(conn, "SELECT id FROM items WHERE id = ?", (id,))
    with db.transaction(conn):
        if body.amount is None:
            conn.execute(
                "DELETE FROM amounts WHERE item_id = ? AND year = ? AND month = ?", (id, body.year, body.month)
            )
        else:
            conn.execute(
                "INSERT INTO amounts (item_id, year, month, cents) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (item_id, year, month) DO UPDATE SET cents = excluded.cents",
                (id, body.year, body.month, db.to_cents(body.amount)),
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

TABLES = ["settings", "members", "categories", "accounts", "account_balances", "items", "item_years", "amounts"]


@app.get("/api/export")
def export(conn: sqlite3.Connection = Conn):
    data = {"format": "nestegg", "schema": len(db.MIGRATIONS), "exported": int(time.time())}
    for t in TABLES:
        data[t] = rows(conn.execute(f"SELECT * FROM {t}"))
    stamp = time.strftime("%Y-%m-%d")
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="nestegg-backup-{stamp}.json"'})


@app.post("/api/restore")
async def restore(request: Request, conn: sqlite3.Connection = Conn):
    try:
        data = json.loads(await request.body())
    except ValueError:
        raise HTTPException(422, "not a JSON file")
    if not isinstance(data, dict) or data.get("format") != "nestegg":
        raise HTTPException(422, "not a Nestegg backup")
    if data.get("schema", 0) > len(db.MIGRATIONS):
        raise HTTPException(422, "this backup is from a newer version of Nestegg")
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
        raise HTTPException(422, f"backup could not be restored: {e}")
    return {"ok": True}


@app.get("/api/export/{year}.csv")
def export_csv(year: int, conn: sqlite3.Connection = Conn):
    members = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM members")}
    categories = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM categories")}
    amounts = calc.year_amounts(conn, year)
    ids = calc.visible_item_ids(conn, year)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["member", "type", "item", "category", *[str(m) for m in range(1, 13)], "total"])
    if ids:
        for i in conn.execute(
            f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))}) ORDER BY member_id, kind, sort, id", ids
        ):
            values = amounts.get(i["id"], [None] * 12)
            w.writerow(
                [
                    members.get(i["member_id"], ""), i["kind"], i["name"], categories.get(i["category_id"], ""),
                    *["" if v is None else f"{v / 100:.2f}" for v in values],
                    f"{sum(v or 0 for v in values) / 100:.2f}",
                ]
            )
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="nestegg-{year}.csv"'},
    )


@app.post("/api/import/preview")
async def import_preview(file: UploadFile = File(...)):
    data = await file.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "file is too large")
    try:
        return {"sheets": importer.read_file(file.filename or "", data)}
    except Exception as e:  # openpyxl raises many different errors for bad files
        raise HTTPException(422, f"could not read the file: {e}")


class ImportRow(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    amounts: list[float | None]


class ImportSheet(BaseModel):
    member_id: int
    kind: Kind
    rows: list[ImportRow]


class ImportIn(BaseModel):
    year: int = Field(ge=1900, le=2200)
    sheets: list[ImportSheet]


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
                set_amounts(conn, item_id, body.year, cents_list(row.amounts))
    return {"created": created, "updated": updated}


# --------------------------------------------------------------------------
# The web app itself. Mounted last so it never shadows the API.

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
