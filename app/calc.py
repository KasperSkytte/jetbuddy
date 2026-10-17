"""Totals, balances and statistics. Everything here works in integer cents."""

import sqlite3
from collections import defaultdict

MONTHS = range(1, 13)


def visible_item_ids(conn: sqlite3.Connection, year: int) -> list[int]:
    rows = conn.execute(
        """
        SELECT item_id FROM item_years WHERE year = ?
        UNION
        SELECT item_id FROM amounts WHERE year = ?
        """,
        (year, year),
    ).fetchall()
    return [r[0] for r in rows]


def year_amounts(conn: sqlite3.Connection, year: int) -> dict[int, list[int | None]]:
    """item_id -> 12 monthly amounts (None where nothing is entered)."""
    out: dict[int, list[int | None]] = defaultdict(lambda: [None] * 12)
    for r in conn.execute("SELECT item_id, month, cents FROM amounts WHERE year = ?", (year,)):
        out[r["item_id"]][r["month"] - 1] = r["cents"]
    return out


def _flows(conn: sqlite3.Connection) -> tuple[dict, dict]:
    """Money moving through accounts per (year, month).

    The main account gets the whole budget's net (income minus expenses). An
    expense item linked to a savings account is a transfer into it; an income
    item linked to one is a withdrawal from it.
    """
    net: dict[tuple[int, int], int] = defaultdict(int)
    linked: dict[int, dict[tuple[int, int], int]] = defaultdict(lambda: defaultdict(int))
    rows = conn.execute(
        """
        SELECT a.year, a.month, i.kind, i.account_id, SUM(a.cents) AS cents
        FROM amounts a JOIN items i ON i.id = a.item_id
        GROUP BY a.year, a.month, i.kind, i.account_id
        """
    )
    for r in rows:
        key = (r["year"], r["month"])
        sign = 1 if r["kind"] == "income" else -1
        net[key] += sign * r["cents"]
        if r["account_id"] is not None:
            linked[r["account_id"]][key] -= sign * r["cents"]
    return net, linked


def _next_month(y: int, m: int) -> tuple[int, int]:
    return (y + 1, 1) if m == 12 else (y, m + 1)


def account_balances(conn: sqlite3.Connection, through_year: int) -> dict[int, dict]:
    """account_id -> {(year, month): (cents, is_manual)} up to December of through_year.

    A typed-in balance wins for its month; every other month is the previous
    month plus that month's flow. Before the first typed-in balance there is
    nothing to compute from, so those months (and accounts without any typed-in
    balance) have none.
    """
    net, linked = _flows(conn)
    snapshots: dict[int, dict[tuple[int, int], int]] = defaultdict(dict)
    for r in conn.execute("SELECT account_id, year, month, cents FROM account_balances"):
        snapshots[r["account_id"]][(r["year"], r["month"])] = r["cents"]

    out: dict[int, dict] = {}
    for acc in conn.execute("SELECT id, kind FROM accounts"):
        flow = net if acc["kind"] == "main" else linked.get(acc["id"], {})
        snaps = snapshots.get(acc["id"], {})
        if not snaps:
            out[acc["id"]] = {}
            continue
        y, m = min(snaps)
        balance = 0
        series = {}
        while y <= through_year:
            if (y, m) in snaps:
                balance = snaps[(y, m)]
                series[(y, m)] = (balance, True)
            else:
                balance += flow.get((y, m), 0)
                series[(y, m)] = (balance, False)
            y, m = _next_month(y, m)
        out[acc["id"]] = series
    return out


def summary(conn: sqlite3.Connection, year: int) -> dict:
    ids = visible_item_ids(conn, year)
    amounts = year_amounts(conn, year)
    items = {
        r["id"]: r
        for r in conn.execute(
            f"SELECT * FROM items WHERE id IN ({','.join('?' * len(ids))})", ids
        )
    } if ids else {}
    savings_ids = {
        r[0] for r in conn.execute("SELECT id FROM accounts WHERE kind = 'savings'")
    }

    income = [0] * 12
    expense = [0] * 12
    savings = [0] * 12
    fixed = [0] * 12
    by_member: dict[int, dict[str, list[int]]] = defaultdict(
        lambda: {"income": [0] * 12, "expense": [0] * 12}
    )
    by_category: dict[tuple[str, int | None], list[int]] = defaultdict(lambda: [0] * 12)
    item_totals = []

    for item_id, item in items.items():
        values = amounts.get(item_id, [None] * 12)
        kind = item["kind"]
        total = 0
        for i, v in enumerate(values):
            if v is None:
                continue
            total += v
            (income if kind == "income" else expense)[i] += v
            by_member[item["member_id"]][kind][i] += v
            by_category[(kind, item["category_id"])][i] += v
            if item["account_id"] in savings_ids:
                savings[i] += v if kind == "expense" else -v
            if kind == "expense" and item["fixed"]:
                fixed[i] += v
        item_totals.append((item_id, kind, total))

    net = [income[i] - expense[i] for i in range(12)]
    cumulative = []
    running = 0
    for v in net:
        running += v
        cumulative.append(running)

    balances = account_balances(conn, year)
    accounts = []
    for acc_id, series in balances.items():
        values, manual = [], []
        for m in MONTHS:
            cents, is_manual = series.get((year, m), (None, False))
            values.append(cents)
            manual.append(is_manual)
        accounts.append({"id": acc_id, "balances": values, "manual": manual})

    top = sorted(
        (t for t in item_totals if t[1] == "expense" and t[2] > 0), key=lambda t: -t[2]
    )[:10]

    return {
        "year": year,
        "income": income,
        "expense": expense,
        "net": net,
        "cumulative": cumulative,
        "savings": savings,
        "fixed": fixed,
        "members": [{"id": k, **v} for k, v in by_member.items()],
        "categories": [
            {"kind": k[0], "id": k[1], "months": v, "total": sum(v)}
            for k, v in by_category.items()
        ],
        "accounts": accounts,
        "top_expenses": [{"item_id": t[0], "total": t[2]} for t in top],
        "has_data": bool(amounts),
    }


def trends(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT a.year, i.kind, i.member_id,
               SUM(a.cents) AS cents,
               SUM(CASE WHEN acc.kind = 'savings' THEN a.cents ELSE 0 END) AS to_savings
        FROM amounts a
        JOIN items i ON i.id = a.item_id
        LEFT JOIN accounts acc ON acc.id = i.account_id
        GROUP BY a.year, i.kind, i.member_id
        """
    ).fetchall()
    years: dict[int, dict] = {}
    for r in rows:
        y = years.setdefault(
            r["year"],
            {"year": r["year"], "income": 0, "expense": 0, "savings": 0, "members": {}},
        )
        y[r["kind"]] += r["cents"]
        y["savings"] += r["to_savings"] if r["kind"] == "expense" else -r["to_savings"]
        m = y["members"].setdefault(r["member_id"], {"income": 0, "expense": 0})
        m[r["kind"]] += r["cents"]

    if not years:
        return []
    balances = account_balances(conn, max(years))
    out = []
    for year in sorted(years):
        y = years[year]
        y["net"] = y["income"] - y["expense"]
        y["accounts"] = {
            acc_id: series.get((year, 12), (None, False))[0]
            for acc_id, series in balances.items()
        }
        y["members"] = [{"id": k, **v} for k, v in y["members"].items()]
        out.append(y)
    return out
