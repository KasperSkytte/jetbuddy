import io

import openpyxl

from tests.conftest import PASSWORD, new_budget


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
    assert r.json() == {"created": 0, "updated": 2, "suspicious": 0}
    items = client.get("/api/years/2027/items").json()
    assert len(items) == 2
    assert items[0]["prev"] == [149.95] * 12


def test_login_required(client):
    assert client.get("/api/session").json() == {"logged_in": False, "budget": None, "has_budgets": False, "can_create": True}
    assert client.get("/api/state").status_code == 401


def test_login_and_logout(client, household):
    assert client.get("/api/session").json()["logged_in"]  # creating a budget logs in
    client.post("/api/logout")
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/login", json={"login": "test", "password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"login": "nobody", "password": PASSWORD}).status_code == 401
    assert client.post("/api/login", json={"login": " TEST ", "password": PASSWORD}).status_code == 200
    assert client.get("/api/state").json()["settings"]["household"] == "Test"


def test_too_many_wrong_passwords(client, household, monkeypatch):
    monkeypatch.setattr("app.main.time.sleep", lambda s: None)
    for _ in range(10):
        client.post("/api/login", json={"login": "test", "password": "nope"})
    assert client.post("/api/login", json={"login": "test", "password": PASSWORD}).status_code == 429


def test_budgets_are_separate(client, household):
    add(client, household, "Alex", "income", "Salary", [1000] * 12)
    client.post("/api/logout")
    other = new_budget(client, login="other", members=["Pat"])
    assert other.status_code == 200
    assert client.get("/api/years/2027/items").json() == []
    assert new_budget(client, login="OTHER").status_code == 409  # username taken, case-insensitively
    client.post("/api/login", json={"login": "test", "password": PASSWORD})
    assert len(client.get("/api/years/2027/items").json()) == 1


def test_new_budgets_can_be_turned_off(client, household, monkeypatch):
    monkeypatch.setenv("JETBUDDY_ALLOW_NEW_BUDGETS", "false")
    assert client.get("/api/session").json()["can_create"] is False
    assert new_budget(client, login="other").status_code == 403


def test_change_password_logs_out_other_devices(client, household):
    other_device = client.cookies.get("jetbuddy_session")
    r = client.put("/api/login-details", json={"current_password": PASSWORD, "password": "new password!", "login": "hansen"})
    assert r.status_code == 200
    assert client.get("/api/state").status_code == 200  # this device stays in
    client.cookies.set("jetbuddy_session", other_device)
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/login", json={"login": "hansen", "password": "new password!"}).status_code == 200
    bad = client.put("/api/login-details", json={"current_password": "wrong", "password": "whatever123"})
    assert bad.status_code == 401


def test_delete_budget(client, household, tmp_path):
    budget_id = client.get("/api/session").json()["budget"]["id"]
    assert (tmp_path / "budgets" / str(budget_id)).exists()
    assert client.post("/api/budget/delete", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/budget/delete", json={"password": PASSWORD}).status_code == 200
    assert not (tmp_path / "budgets" / str(budget_id)).exists()
    assert client.get("/api/session").json()["has_budgets"] is False


def test_short_password_rejected(client):
    r = client.post("/api/budgets", json={"household": "x", "members": ["a"], "login": "x1", "password": "short"})
    assert r.status_code == 422


def test_excel_export(client, household):
    savings = account(household, "savings")
    cats = {c["name"]: c["id"] for c in household["categories"]}
    add(client, household, "Alex", "income", "Salary", [31250] * 12)
    add(client, household, "Sam", "income", "Salary", [22000] * 12)
    add(client, household, "Shared", "expense", "Rent", [12000] * 12, category_id=cats["Housing"], fixed=True)
    add(client, household, "Shared", "expense", "Groceries", [8500] * 12, category_id=cats["Groceries"])
    add(client, household, "Alex", "expense", "Phone", [149.95] * 12, category_id=cats["Subscriptions"], fixed=True)
    add(client, household, "Shared", "expense", "Savings", [9000] * 12, category_id=cats["Savings"], account_id=savings["id"])
    r = client.get("/api/export/2027.xlsx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert "budget-2027.xlsx" in r.headers["content-disposition"]
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames[:2] == ["Summary", "Budget"]
    summary = {row[0]: row[1:] for row in wb["Summary"].iter_rows(values_only=True) if row[0]}
    assert summary["Total income"][:2] == (53250, 639000)
    assert summary["Total expenses"][1] == 12000 * 12 + 8500 * 12 + 149.95 * 12 + 9000 * 12
    assert summary["   of which fixed expenses"][1] == (12000 + 149.95) * 12
    budget = [row for row in wb["Budget"].iter_rows(values_only=True)]
    labels = [row[0] for row in budget]
    # Expenses are categorised, so grouped by category in the categories' order.
    assert labels.index("Housing") < labels.index("Groceries") < labels.index("Subscriptions")
    surplus = next(row for row in budget if row[0] == "Surplus (income − expenses)")
    assert surplus[3] == 53250 - (12000 + 8500 + 149.95 + 9000)
    rent = next(row for row in budget if row[0] == "Rent")
    assert rent[1] == "Shared" and rent[2] == "✓"
    # Grouped by person when asked.
    wb2 = openpyxl.load_workbook(io.BytesIO(client.get("/api/export/2027.xlsx?group=member").content))
    labels2 = [row[0] for row in wb2["Budget"].iter_rows(values_only=True)]
    assert "Housing" not in labels2 and labels2.count("Shared") >= 1


def test_import_in_thousands(client, household):
    alex = member(household, "Alex")["id"]
    r = client.post("/api/import/commit", json={
        "year": 2027, "scale": 1000,
        "sheets": [{"member_id": alex, "kind": "income", "rows": [{"name": "Salary", "amounts": [27.8] + [None] * 11}]}],
    })
    assert r.status_code == 200, r.text
    assert client.get("/api/years/2027/items").json()[0]["amounts"][0] == 27800


def test_checks_find_and_fix_amounts_off_by_powers_of_ten(client, household):
    cats = {c["name"]: c["id"] for c in household["categories"]}
    # Salary with one month imported 100 times too big.
    salary = add(client, household, "Alex", "income", "Salary", [31250] * 5 + [3125000] + [31250] * 6)
    # Phone: 2026 right, 2027 1000 times too small (149,95 read as 0,14995). Same
    # number of months each way, so either year could be the wrong one.
    phone = add(client, household, "Alex", "expense", "Phone", [149.95] * 12, year=2026)
    client.put(f"/api/items/{phone['id']}/amounts", json={"year": 2027, "amounts": [0.18] * 12})
    # Rent wrong in every month: only the comparison with income can see it.
    add(client, household, "Shared", "expense", "Rent", [1200000] * 12, category_id=cats["Housing"])
    found = client.get("/api/checks").json()["findings"]
    salary_f = next(f for f in found if f["name"] == "Salary")
    assert salary_f["type"] == "item" and salary_f["where"] == [{"year": 2027, "months": [6]}] and salary_f["factor"] == 100
    assert salary_f["options"] == [{"action": "scale", "multiply": 0.01, "where": [{"year": 2027, "months": [6]}]}]
    phone_f = next(f for f in found if f["name"] == "Phone")
    assert phone_f["type"] == "split" and phone_f["factor"] == 1000
    assert [(o["multiply"], o["where"][0]["year"]) for o in phone_f["options"]] == [(0.001, 2026), (1000, 2027)]
    assert sum(1 for f in found if f["name"] == "Rent" and f["type"] == "large") == 12

    # Fix the salary month; fix the phone's 2027; say the rent in January is right.
    opt = salary_f["options"][0]
    r = client.post("/api/checks/fix", json={"item_id": salary["id"], "where": opt["where"], "multiply": opt["multiply"]})
    assert r.status_code == 200, r.text
    opt = phone_f["options"][1]
    client.post("/api/checks/fix", json={"item_id": phone["id"], "where": opt["where"], "multiply": opt["multiply"]})
    items = {i["name"]: i for i in client.get("/api/years/2027/items").json()}
    assert items["Salary"]["amounts"][5] == 31250 and items["Phone"]["amounts"][0] == 180
    rent_jan = next(f for f in client.get("/api/checks").json()["findings"] if f["name"] == "Rent")
    client.post("/api/checks/dismiss", json={"id": rent_jan["id"]})
    left = client.get("/api/checks").json()["findings"]
    assert rent_jan["id"] not in {f["id"] for f in left}
    assert not any(f["name"] in ("Salary", "Phone") for f in left)
    client.post("/api/checks/reset")
    assert any(f["id"] == rent_jan["id"] for f in client.get("/api/checks").json()["findings"])


def test_checks_typed_in_balance(client, household):
    main = account(household, "main")
    add(client, household, "Alex", "income", "Salary", [30000] * 12)
    add(client, household, "Shared", "expense", "Rent", [20000] * 12)
    client.put(f"/api/accounts/{main['id']}/balance", json={"year": 2027, "month": 1, "amount": 50000})
    client.put(f"/api/accounts/{main['id']}/balance", json={"year": 2027, "month": 3, "amount": 7000000})  # meant 70.000
    f = next(f for f in client.get("/api/checks").json()["findings"] if f["type"] == "balance")
    assert f["where"] == [{"year": 2027, "months": [3]}] and f["factor"] == 100
    opt = f["options"][0]
    client.post("/api/checks/fix", json={"account_id": main["id"], "where": opt["where"], "multiply": opt["multiply"]})
    assert client.get(f"/api/accounts/{main['id']}/balances").json()[1]["amount"] == 70000


def test_import_reports_suspicious_amounts(client, household):
    alex = member(household, "Alex")["id"]
    r = client.post("/api/import/commit", json={"year": 2027, "sheets": [{"member_id": alex, "kind": "income", "rows": [
        {"name": "Salary", "amounts": [31250] * 11 + [3125000]}]}]})
    assert r.json()["suspicious"] == 1
