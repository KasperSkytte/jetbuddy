"""Add a made-up family to a Jetbuddy, to try it out or take screenshots.

    python scripts/seed_demo.py http://localhost:8000

Creates the budget "demo" with the password "demo-demo".
"""

import http.cookiejar
import json
import random
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
# Creating the budget logs in; the cookie keeps it that way for the calls after.
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with opener.open(req) as res:
        return json.loads(res.read())


def monthly(v, jitter=0.0):
    return [round(v * (1 + random.uniform(-jitter, jitter))) for _ in range(12)]


def every(v, months):
    return [v if m + 1 in months else None for m in range(12)]


def main():
    random.seed(7)
    state = call(
        "POST",
        "/api/budgets",
        {
            "household": "The Demo Family",
            "login": "demo",
            "password": "demo-demo",
            "language": "en",
            "decimal": ".",
            "currency": "USD",
            "members": ["Alex", "Sam", "Mia", "Leo"],
            "shared_name": "Shared",
        },
    )
    m = {x["name"]: x["id"] for x in state["members"]}
    cat = {c["name"]: c["id"] for c in state["categories"]}
    acc = {a["kind"]: a["id"] for a in state["accounts"]}

    items = [
        ("Alex", "income", "Salary", "Salary", lambda y: monthly(4200 + 150 * (y - 2025)), {}),
        ("Alex", "income", "Bonus", "Salary", lambda y: every(2500, [12]), {}),
        ("Sam", "income", "Salary", "Salary", lambda y: monthly(3600 + 120 * (y - 2025)), {}),
        ("Sam", "income", "Child benefit", "Benefits & allowances", lambda y: every(540, [1, 4, 7, 10]), {}),
        ("Alex", "expense", "Phone", "Subscriptions", lambda y: monthly(25), {"fixed": True}),
        ("Alex", "expense", "Gym", "Leisure", lambda y: monthly(45), {"fixed": True}),
        ("Alex", "expense", "Student loan", "Loans & debt", lambda y: monthly(180), {"fixed": True}),
        ("Sam", "expense", "Phone", "Subscriptions", lambda y: monthly(20), {"fixed": True}),
        ("Sam", "expense", "Union", "Other", lambda y: every(160, [1, 4, 7, 10]), {"fixed": True}),
        ("Sam", "expense", "Dentist", "Health", lambda y: every(140, [3, 9]), {}),
        ("Mia", "expense", "Pocket money", "Childcare & school", lambda y: monthly(40), {"fixed": True}),
        ("Mia", "expense", "Football club", "Leisure", lambda y: every(180, [2, 8]), {}),
        ("Mia", "expense", "School & after-school", "Childcare & school", lambda y: monthly(210), {"fixed": True}),
        ("Leo", "expense", "Daycare", "Childcare & school", lambda y: monthly(390), {"fixed": True}),
        ("Leo", "expense", "Savings for Leo", "Savings", lambda y: monthly(50), {"fixed": True}),
        ("Shared", "expense", "Rent", "Housing", lambda y: monthly(2100 + 60 * (y - 2025)), {"fixed": True}),
        ("Shared", "expense", "Electricity", "Utilities", lambda y: [round(v * (1 + 0.04 * (y - 2025))) for v in [150, 140, 120, 100, 85, 70, 65, 70, 85, 105, 130, 150]], {}),
        ("Shared", "expense", "Internet", "Utilities", lambda y: monthly(55), {"fixed": True}),
        ("Shared", "expense", "Groceries", "Groceries", lambda y: monthly(1150 + 40 * (y - 2025), 0.08), {}),
        ("Shared", "expense", "Car loan", "Transport", lambda y: monthly(320), {"fixed": True}),
        ("Shared", "expense", "Car insurance", "Insurance", lambda y: every(780, [9]), {}),
        ("Shared", "expense", "Fuel & charging", "Transport", lambda y: monthly(140, 0.2), {}),
        ("Shared", "expense", "Home insurance", "Insurance", lambda y: every(420, [2]), {}),
        ("Shared", "expense", "Streaming", "Subscriptions", lambda y: monthly(32), {"fixed": True}),
        ("Shared", "expense", "Summer holiday", "Leisure", lambda y: every(2400, [7]), {}),
        ("Shared", "expense", "Christmas", "Leisure", lambda y: every(900, [12]), {}),
        ("Shared", "expense", "Savings", "Savings", lambda y: monthly(800 + 100 * (y - 2025)), {"fixed": True, "account_id": acc["savings"]}),
    ]
    for who, kind, name, category, amounts, extra in items:
        item = call(
            "POST",
            "/api/items",
            {"member_id": m[who], "kind": kind, "name": name, "category_id": cat.get(category), "year": 2025, "amounts": amounts(2025), **extra},
        )
        for year in (2026, 2027):
            call("PUT", f"/api/items/{item['id']}/amounts", {"year": year, "amounts": amounts(year)})
    call("PUT", f"/api/accounts/{acc['main']}/balance", {"year": 2025, "month": 1, "amount": 3200})
    call("PUT", f"/api/accounts/{acc['savings']}/balance", {"year": 2025, "month": 1, "amount": 18500})
    call("PUT", f"/api/accounts/{acc['main']}/balance", {"year": 2026, "month": 6, "amount": 4100})
    print("Demo family created: log in as demo / demo-demo.")


if __name__ == "__main__":
    main()
