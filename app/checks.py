"""Looking for amounts that are probably wrong by a factor of 10, 100 or 1000:
a decimal separator read as a thousands separator, or the other way round,
turns 31.250 into 31,250 or 149,95 into 14,995. Also amounts with decimals
from before the budget was set to whole numbers.

Nothing here changes anything; it lists findings, each with the factor that
would fix it when the difference is close to a power of ten.
"""

import math
import sqlite3
import statistics
from collections import defaultdict

from . import banking, calc, db

# How far off an amount must be to be reported. Real budgets vary (a bonus
# month, a cold winter's electricity), but not 20 times over.
THRESHOLD = 20
# An expense this many times the household's usual monthly income.
INCOME_MULTIPLE = 5


def power_of_ten(ratio: float) -> int | None:
    """100 for a ratio of 97 or 104, 1/1000 as -1000 for 0.001; None when the
    ratio isn't close to a power of ten (then there is no obvious fix)."""
    if ratio <= 0:
        return None
    exp = math.log10(ratio)
    p = round(exp)
    if p == 0 or abs(exp - p) > 0.2:
        return None
    return 10**p if p > 0 else -(10 ** -p)


def _off(ratio: float) -> bool:
    return ratio >= THRESHOLD or ratio <= 1 / THRESHOLD


def _multiply(factor: int | None) -> float | None:
    """What to multiply by to undo a factor from power_of_ten()."""
    if not factor:
        return None
    return 1 / factor if factor > 0 else -factor


def _where(entries) -> list[dict]:
    """[(year, month), ...] as [{year, months}], by year."""
    out: dict[int, list[int]] = defaultdict(list)
    for (y, m), _ in entries:
        out[y].append(m)
    return [{"year": y, "months": sorted(ms)} for y, ms in sorted(out.items())]


def _scale_option(where: list[dict], factor: int | None) -> list[dict]:
    multiply = _multiply(factor)
    return [{"action": "scale", "multiply": multiply, "where": where}] if multiply else []


def find(conn: sqlite3.Connection, dismissed: set[str] = frozenset()) -> dict:
    items = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM items")}
    values: dict[int, dict[tuple[int, int], int]] = defaultdict(dict)
    count = 0
    for r in conn.execute("SELECT item_id, year, month, cents FROM amounts WHERE cents != 0"):
        values[r["item_id"]][(r["year"], r["month"])] = r["cents"]
        count += 1

    findings = []
    flagged: set[tuple[int, int, int]] = set()  # (item, year, month)

    def add(f: dict) -> None:
        where = ";".join(f"{w['year']}:{','.join(map(str, w['months']))}" for w in f["where"])
        f["id"] = f"{f['type']}:{f.get('item_id') or ''}:{f.get('account_id') or ''}:{where}:{f.get('factor')}"
        f["year"] = f["where"][0]["year"]
        if f["id"] not in dismissed:
            findings.append(f)

    def item_finding(type_, item_id, where, **extra):
        item = items[item_id]
        return {"type": type_, "item_id": item_id, "name": item["name"], "kind": item["kind"], "member_id": item["member_id"], "where": where, **extra}

    # 1. Amounts of an item that fall into groups of very different size. The
    #    amounts within a factor THRESHOLD of each other form a group; the
    #    biggest group is the usual one and the others are reported. Two
    #    groups of the same size could be either way round, so both fixes are
    #    offered.
    for item_id, vals in values.items():
        entries = sorted(vals.items(), key=lambda kv: abs(kv[1]))
        groups = [[entries[0]]]
        for e in entries[1:]:
            if abs(e[1]) / abs(groups[-1][-1][1]) >= THRESHOLD:
                groups.append([e])
            else:
                groups[-1].append(e)
        if len(groups) == 1:
            continue
        typical = lambda g: statistics.median(abs(v) for _, v in g)
        sizes = sorted((len(g) for g in groups), reverse=True)
        if sizes[0] == sizes[1] and len(groups) == 2:
            low, high = groups
            factor = power_of_ten(typical(high) / typical(low))
            for k, _ in low + high:
                flagged.add((item_id, *k))
            add(item_finding(
                "split", item_id, _where(high),
                low=_where(low), low_values=sorted({v / 100 for _, v in low})[:3],
                high_values=sorted({v / 100 for _, v in high})[:3], factor=factor,
                options=_scale_option(_where(high), factor) + _scale_option(_where(low), -factor if factor else None),
            ))
            continue
        usual = max(groups, key=len)
        for g in groups:
            if g is usual:
                continue
            factor = power_of_ten(typical(g) / typical(usual))
            for k, _ in g:
                flagged.add((item_id, *k))
            add(item_finding(
                "item", item_id, _where(g), values=[v / 100 for _, v in sorted(g)][:12],
                typical=typical(usual) / 100, factor=factor, options=_scale_option(_where(g), factor),
            ))

    # 0. Cells an import couldn't read: the amount is missing.
    gaps: dict[tuple[int, int], dict[int, str]] = defaultdict(dict)
    for r in conn.execute("SELECT item_id, year, month, raw FROM unreadable"):
        if r["item_id"] in items:
            gaps[(r["item_id"], r["year"])][r["month"]] = r["raw"]
    for (item_id, y), cells in sorted(gaps.items()):
        months = sorted(cells)
        add(item_finding("unreadable", item_id, [{"year": y, "months": months}], raw=[cells[m] for m in months], factor=None, options=[]))

    # 2. Planned against what the bank actually paid.
    years = sorted({y for vals in values.values() for (y, _) in vals}
                   | {r[0] for r in conn.execute("SELECT DISTINCT year FROM bank_transactions")})
    for y in years:
        for item_id, actual in banking.actuals(conn, y).items():
            for i, paid in enumerate(actual):
                planned = values.get(item_id, {}).get((y, i + 1))
                if not paid or not planned or (item_id, y, i + 1) in flagged:
                    continue
                ratio = abs(planned) / abs(paid)
                if _off(ratio):
                    flagged.add((item_id, y, i + 1))
                    where = [{"year": y, "months": [i + 1]}]
                    factor = power_of_ten(ratio)
                    add(item_finding(
                        "bank", item_id, where, values=[planned / 100], actual=paid / 100, factor=factor,
                        options=_scale_option(where, factor) + [{"action": "bank", "where": where}],
                    ))

    # 3. An expense bigger than months of the household's income: catches an
    #    item that is wrong in every month, which (1) can't see.
    income_months = [
        r["cents"] for r in conn.execute(
            "SELECT SUM(a.cents) AS cents FROM amounts a JOIN items i ON i.id = a.item_id "
            "WHERE i.kind = 'income' GROUP BY a.year, a.month HAVING SUM(a.cents) > 0"
        )
    ]
    if len(income_months) >= 3:
        monthly_income = statistics.median(income_months)
        for item_id, vals in values.items():
            if items[item_id]["kind"] != "expense":
                continue
            for (y, m), v in sorted(vals.items()):
                if (item_id, y, m) not in flagged and abs(v) > INCOME_MULTIPLE * monthly_income:
                    flagged.add((item_id, y, m))
                    where = [{"year": y, "months": [m]}]
                    add(item_finding(
                        "large", item_id, where, values=[v / 100], income=monthly_income / 100, factor=None,
                        options=_scale_option(where, 100) + _scale_option(where, 1000),
                    ))

    # 4. A typed-in balance of the budget account far from what the budget
    #    expects. Other accounts are left out: money moved to them from the
    #    budget account is meant to be spent, so their balance drifting from
    #    the plan is no sign of a typing error.
    if years:
        net, _ = calc._flows(conn)
        series = calc.account_balances(conn, max(years) + 1)
        kinds = {r["id"]: r["kind"] for r in conn.execute("SELECT id, kind FROM accounts")}
        names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM accounts")}
        for acc_id, months in series.items():
            if kinds.get(acc_id) != "main":
                continue
            flow = net
            keys = sorted(months)
            for prev, key in zip(keys, keys[1:]):
                cents, source = months[key]
                if source != "manual":
                    continue
                expected = months[prev][0] + flow.get(key, 0)
                if abs(expected) < 100_000 or not cents or (cents > 0) != (expected > 0):
                    continue  # small or crossing zero: a ratio says nothing
                ratio = abs(cents) / abs(expected)
                if _off(ratio):
                    where = [{"year": key[0], "months": [key[1]]}]
                    factor = power_of_ten(ratio)
                    add({
                        "type": "balance", "account_id": acc_id, "name": names.get(acc_id, ""), "where": where,
                        "values": [cents / 100], "expected": expected / 100, "factor": factor,
                        "options": _scale_option(where, factor),
                    })

    # 5. Amounts with decimals while the budget is set to whole numbers.
    mode = db.decimals_mode(conn)
    if mode != "keep":
        def round_options(where):
            modes = ["nearest", "up", "down"] if mode == "only" else [mode]
            return [{"action": "round", "mode": m, "where": where} for m in modes]

        fractions: dict[tuple[int, int], dict[int, int]] = defaultdict(dict)
        for item_id, vals in values.items():
            for (y, m), v in vals.items():
                if v % 100:
                    fractions[(item_id, y)][m] = v
        for (item_id, y), cells in sorted(fractions.items()):
            where = [{"year": y, "months": sorted(cells)}]
            add(item_finding("decimals", item_id, where, values=[cells[m] / 100 for m in sorted(cells)][:12],
                             factor=None, options=round_options(where)))
        balances: dict[tuple[int, int], dict[int, int]] = defaultdict(dict)
        for r in conn.execute("SELECT account_id, year, month, cents FROM account_balances WHERE cents % 100 != 0"):
            balances[(r["account_id"], r["year"])][r["month"]] = r["cents"]
        names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM accounts")}
        for (acc_id, y), cells in sorted(balances.items()):
            where = [{"year": y, "months": sorted(cells)}]
            add({"type": "decimals", "account_id": acc_id, "name": names.get(acc_id, ""), "where": where,
                 "values": [cells[m] / 100 for m in sorted(cells)][:12], "factor": None, "options": round_options(where)})

    order = {"unreadable": -1, "split": 0, "item": 0, "bank": 1, "large": 2, "balance": 3, "decimals": 4}
    findings.sort(key=lambda f: (f["year"], order[f["type"]], f["name"].lower()))
    return {"findings": findings, "checked": count}


def fix(conn: sqlite3.Connection, *, item_id: int | None, account_id: int | None, where: list[dict],
        multiply: float | None = None, use_bank: bool = False, round_to: str | None = None) -> None:
    """Multiply the amounts by a factor, take the bank's amount instead, or
    round them to whole numbers (round_to: nearest, up or down)."""
    if round_to:
        table, key = ("account_balances", "account_id") if account_id is not None else ("amounts", "item_id")
        for w in where:
            for m in w["months"]:
                r = conn.execute(f"SELECT cents FROM {table} WHERE {key} = ? AND year = ? AND month = ?",
                                 (account_id if account_id is not None else item_id, w["year"], m)).fetchone()
                if r:
                    conn.execute(f"UPDATE {table} SET cents = ? WHERE {key} = ? AND year = ? AND month = ?",
                                 (db.round_cents(r[0], round_to), account_id if account_id is not None else item_id, w["year"], m))
        return
    for w in where:
        year = w["year"]
        actual = banking.actuals(conn, year).get(item_id, [None] * 12) if use_bank else None
        for m in w["months"]:
            if account_id is not None and multiply:
                conn.execute(
                    "UPDATE account_balances SET cents = CAST(ROUND(cents * ?) AS INTEGER) WHERE account_id = ? AND year = ? AND month = ?",
                    (multiply, account_id, year, m),
                )
            elif use_bank and actual[m - 1] is not None:
                conn.execute("UPDATE amounts SET cents = ? WHERE item_id = ? AND year = ? AND month = ?", (actual[m - 1], item_id, year, m))
            elif multiply:
                conn.execute(
                    "UPDATE amounts SET cents = CAST(ROUND(cents * ?) AS INTEGER) WHERE item_id = ? AND year = ? AND month = ?",
                    (multiply, item_id, year, m),
                )
