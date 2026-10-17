import io

import openpyxl


def member(state, name):
    return next(m for m in state["members"] if m["name"] == name)


def account(state, kind):
    return next(a for a in state["accounts"] if a["kind"] == kind)


def add(client, state, who, kind, name, amounts, year=2027, **extra):
    r = client.post(
        "/api/items",
        json={"member_id": member(state, who)["id"], "kind": kind, "name": name, "year": year, "amounts": amounts, **extra},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_setup_creates_members_shared_categories_accounts(client, household):
    names = [m["name"] for m in household["members"]]
    assert names == ["Alex", "Sam", "Kim", "Robin", "Shared"]
    assert member(household, "Shared")["is_shared"]
    assert {c["kind"] for c in household["categories"]} == {"income", "expense"}
    assert sorted(a["kind"] for a in household["accounts"]) == ["main", "savings"]
    assert client.post("/api/setup", json={"household": "x", "members": ["a"]}).status_code == 409


def test_amounts_are_exact_and_summed(client, household):
    add(client, household, "Alex", "income", "Salary", [31250] * 12)
    add(client, household, "Alex", "expense", "Phone", [149.95] * 12)
    add(client, household, "Shared", "expense", "Rent", [12000] * 12)
    s = client.get("/api/summary/2027").json()
    assert s["income"] == [31250] * 12
    assert s["expense"][0] == 12149.95
    assert sum(s["expense"]) == 145799.4  # 149.95 * 12 + 12000 * 12, no float drift
    assert s["net"][0] == 31250 - 12149.95
    assert s["cumulative"][-1] == round((31250 - 12149.95) * 12, 2)


def test_single_cell_edit_and_clear(client, household):
    item = add(client, household, "Sam", "expense", "Dentist", [None] * 12)
    assert client.put(f"/api/items/{item['id']}/amount", json={"year": 2027, "month": 4, "amount": 650}).status_code == 200
    items = client.get("/api/years/2027/items").json()
    assert items[0]["amounts"][3] == 650
    client.put(f"/api/items/{item['id']}/amount", json={"year": 2027, "month": 4, "amount": None})
    items = client.get("/api/years/2027/items").json()
    assert items[0]["amounts"] == [None] * 12  # still in the year, just empty


def test_accounts_follow_budget_and_typed_in_balances(client, household):
    savings = account(household, "savings")
    main = account(household, "main")
    add(client, household, "Alex", "income", "Salary", [1000] * 12)
    add(client, household, "Shared", "expense", "Savings", [300] * 12, account_id=savings["id"])
    client.put(f"/api/accounts/{savings['id']}/balance", json={"year": 2027, "month": 1, "amount": 87000})
    client.put(f"/api/accounts/{main['id']}/balance", json={"year": 2027, "month": 1, "amount": 7127})
    # A real balance later in the year overrides the computed one from then on.
    client.put(f"/api/accounts/{main['id']}/balance", json={"year": 2027, "month": 6, "amount": 5000})
    s = client.get("/api/summary/2027").json()
    acc = {a["id"]: a for a in s["accounts"]}
    assert acc[savings["id"]]["balances"][1] == 87300
    assert acc[savings["id"]]["balances"][11] == 87000 + 300 * 11
    assert acc[main["id"]]["balances"][1] == 7127 + 700
    assert acc[main["id"]]["balances"][5] == 5000
    assert acc[main["id"]]["manual"][5] is True
    assert acc[main["id"]]["balances"][6] == 5700
    assert s["savings"] == [300] * 12
    # The balance carries over into next year.
    s2 = client.get("/api/summary/2028").json()
    acc2 = {a["id"]: a for a in s2["accounts"]}
    assert acc2[savings["id"]]["balances"][0] == 87000 + 300 * 11


def test_copy_year_and_remove_from_year(client, household):
    rent = add(client, household, "Shared", "expense", "Rent", [10000] * 12)
    add(client, household, "Shared", "expense", "Holiday", [None] * 6 + [2500] + [None] * 5)
    assert client.get("/api/years/2028/items").json() == []
    r = client.post("/api/years/2028/copy", json={"from_year": 2027})
    assert r.json() == {"copied": 2}
    items = client.get("/api/years/2028/items").json()
    assert len(items) == 2
    assert items[0]["prev"] == [10000] * 12
    # Copying again adds nothing.
    assert client.post("/api/years/2028/copy", json={"from_year": 2027}).json() == {"copied": 0}
    # Taking it out of 2028 leaves 2027 alone.
    client.delete(f"/api/items/{rent['id']}", params={"year": 2028})
    assert len(client.get("/api/years/2028/items").json()) == 1
    assert len(client.get("/api/years/2027/items").json()) == 2
    # Taking it out of its last year deletes it.
    client.delete(f"/api/items/{rent['id']}", params={"year": 2027})
    assert len(client.get("/api/years/2027/items").json()) == 1


def test_trends(client, household):
    add(client, household, "Alex", "income", "Salary", [1000] * 12, year=2026)
    add(client, household, "Alex", "income", "Salary 2", [1100] * 12, year=2027)
    t = client.get("/api/trends").json()
    assert [y["year"] for y in t] == [2026, 2027]
    assert t[1]["income"] == 13200


def test_backup_roundtrip(client, household):
    add(client, household, "Alex", "income", "Salary", [1000.5] * 12)
    backup = client.get("/api/export").json()
    client.delete(f"/api/items/{backup['items'][0]['id']}")
    assert client.get("/api/years/2027/items").json() == []
    import json

    assert client.post("/api/restore", content=json.dumps(backup)).status_code == 200
    assert client.get("/api/years/2027/items").json()[0]["amounts"] == [1000.5] * 12


def test_import_spreadsheet_merges_items_across_years(client, household):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Alex ud"
    ws.append(["", "Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"])
    ws.append(["Phone", *["-149,95"] * 12])
    ws.append(["Dentist", None, None, None, -650] + [None] * 8)
    summary = wb.create_sheet("Summary")
    summary.append(["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])
    summary.append(["Total", *[f"=SUM('Alex ud'!{c}:{c})" for c in "BCDEFGHIJKLM"]])
    buf = io.BytesIO()
    wb.save(buf)

    r = client.post("/api/import/preview", files={"file": ("budget.xlsx", buf.getvalue())})
    assert r.status_code == 200, r.text
    sheets = {s["name"]: s for s in r.json()["sheets"]}
    alex = sheets["Alex ud"]
    assert alex["kind"] == "expense"
    assert alex["rows"][0]["amounts"] == [149.95] * 12
    assert alex["rows"][1]["amounts"][3] == 650
    assert sheets["Summary"]["looks_like_summary"]

    alex_id = member(household, "Alex")["id"]
    for year in (2026, 2027):
        r = client.post(
            "/api/import/commit",
            json={"year": year, "sheets": [{"member_id": alex_id, "kind": "expense", "rows": alex["rows"]}]},
        )
        assert r.status_code == 200, r.text
    assert r.json() == {"created": 0, "updated": 2}
    items = client.get("/api/years/2027/items").json()
    assert len(items) == 2
    assert items[0]["prev"] == [149.95] * 12


def test_password(client, monkeypatch):
    monkeypatch.setenv("JETBUDDY_PASSWORD", "hunter2")
    assert client.get("/api/state").status_code == 401
    assert client.get("/api/session").json() == {"auth_required": True, "logged_in": False}
    assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"password": "hunter2"}).status_code == 200
    assert client.get("/api/state").status_code == 200
