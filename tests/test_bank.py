"""Bank sync against a fake Enable Banking that checks requests like the real one."""

import json
from datetime import date, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import banking

APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
TODAY = date.today()
THIS_MONTH = TODAY.replace(day=1)
LAST_MONTH_END = THIS_MONTH - timedelta(days=1)
TWO_MONTHS_END = LAST_MONTH_END.replace(day=1) - timedelta(days=1)


def tx(ref, day, amount, indicator, name="", text=""):
    party = "creditor" if indicator == "DBIT" else "debtor"
    return {
        "entry_reference": ref,
        "booking_date": day.isoformat(),
        "transaction_amount": {"currency": "DKK", "amount": amount},
        "credit_debit_indicator": indicator,
        "status": "BOOK",
        party: {"name": name},
        "remittance_information": [text] if text else [],
    }


class FakeBank:
    ACCOUNTS = [
        {"uid": "u-budget", "account_id": {"iban": "DK5000400440116243"}, "name": "Budgetkonto", "currency": "DKK"},
        {"uid": "u-savings", "account_id": {"iban": "DK1111"}, "name": "Opsparing", "currency": "DKK"},
    ]

    def __init__(self, public_key):
        self.shared = {"u-budget", "u-savings"}  # the accounts the bank lets Jetbuddy see
        self.public_key = public_key
        self.requests = []
        self.balance = "10000.00"
        self.budget_tx = [
            tx("t1", TWO_MONTHS_END - timedelta(days=5), "31250.00", "CRDT", "Acme ApS", "Løn"),
            tx("t2", LAST_MONTH_END - timedelta(days=20), "129.00", "DBIT", "NETFLIX.COM", "Netflix 1234"),
            tx("t3", LAST_MONTH_END - timedelta(days=3), "12000.00", "DBIT", "", "Husleje"),
            tx("t4", TODAY, "500.00", "DBIT", "Rema 1000", ""),
            {**tx("p1", TODAY, "99.00", "DBIT", "Pending"), "status": "PDNG"},
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        token = request.headers["Authorization"].removeprefix("Bearer ")
        head = jwt.get_unverified_header(token)
        assert head["kid"] == APP_ID and head["alg"] == "RS256"
        claims = jwt.decode(token, self.public_key, algorithms=["RS256"], audience="api.enablebanking.com")
        assert claims["iss"] == "enablebanking.com" and claims["exp"] - claims["iat"] <= 86400
        path = request.url.path
        if path == "/aspsps":
            return httpx.Response(200, json={"aspsps": [
                {"name": "Danske Bank", "country": "DK", "logo": "x", "maximum_consent_validity": 90 * 86400, "required_psu_headers": []},
            ]})
        if path == "/auth":
            body = json.loads(request.content)
            self.auth = body
            return httpx.Response(200, json={"url": f"https://bank.example/login?state={body['state']}", "authorization_id": "a1"})
        if path == "/sessions" and request.method == "POST":
            assert json.loads(request.content) == {"code": "good-code"}
            return httpx.Response(200, json={
                "session_id": "s1",
                "access": {"valid_until": (TODAY + timedelta(days=90)).isoformat() + "T00:00:00+00:00"},
                "accounts": [a for a in self.ACCOUNTS if a["uid"] in self.shared],
            })
        if path == "/sessions/s1" and request.method == "GET":
            return httpx.Response(200, json={"status": "AUTHORIZED", "accounts": sorted(self.shared)})
        if path.endswith("/balances"):
            amount = self.balance if "u-budget" in path else "186000.00"
            return httpx.Response(200, json={"balances": [
                {"balance_type": "ITAV", "balance_amount": {"currency": "DKK", "amount": "1.00"}},
                {"balance_type": "CLBD", "balance_amount": {"currency": "DKK", "amount": amount}, "reference_date": TODAY.isoformat()},
            ]})
        if path.endswith("/transactions"):
            if "u-savings" in path:
                return httpx.Response(200, json={"transactions": []})
            # Two pages, to exercise continuation.
            if "continuation_key" in request.url.params:
                return httpx.Response(200, json={"transactions": self.budget_tx[2:]})
            return httpx.Response(200, json={"transactions": self.budget_tx[:2], "continuation_key": "next"})
        if path == "/sessions/s1" and request.method == "DELETE":
            return httpx.Response(200, json={"message": "OK"})
        return httpx.Response(404, json={"message": "nope", "error": "NOT_FOUND"})


@pytest.fixture
def bank(client, household, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    fake = FakeBank(key.public_key())
    monkeypatch.setattr(banking, "TRANSPORT", httpx.MockTransport(fake.handler))
    r = client.put("/api/bank/config", json={"app_id": APP_ID, "private_key": pem})
    assert r.status_code == 200, r.text
    return fake


def connect(client):
    r = client.post("/api/bank/connect", json={"name": "Danske Bank", "country": "dk"})
    assert r.status_code == 200, r.text
    state = parse_qs(urlparse(r.json()["url"]).query)["state"][0]
    return client.get("/api/bank/callback", params={"code": "good-code", "state": state}, follow_redirects=False)


def test_config_rejects_bad_key(client, household):
    r = client.put("/api/bank/config", json={"app_id": APP_ID, "private_key": "not a key"})
    assert r.status_code == 422
    r = client.put("/api/bank/config", json={"app_id": "not an id", "private_key": None})
    assert r.status_code == 422
    assert client.get("/api/bank/status").json()["configured"] is False


def test_certificate_made_by_jetbuddy(client, household, monkeypatch):
    """The flow in the app: Jetbuddy makes the key, the user registers the
    certificate with Enable Banking and pastes back the application ID."""
    cert_pem = client.post("/api/bank/certificate").json()["certificate"]
    assert cert_pem.startswith("-----BEGIN CERTIFICATE-----")
    assert client.post("/api/bank/certificate").json()["certificate"] == cert_pem  # same until used
    assert client.get("/api/bank/status").json()["pending_certificate"] == cert_pem
    from cryptography import x509

    fake = FakeBank(x509.load_pem_x509_certificate(cert_pem.encode()).public_key())
    monkeypatch.setattr(banking, "TRANSPORT", httpx.MockTransport(fake.handler))
    r = client.put("/api/bank/config", json={"app_id": APP_ID})
    assert r.status_code == 200, r.text
    assert r.json()["test"]["ok"] is True  # the fake accepted the signature
    status = client.get("/api/bank/status").json()
    assert status["configured"] and status["certificate"] == cert_pem and status["pending_certificate"] is None


def test_connection_test_reports_rejection(client, household, bank, monkeypatch):
    monkeypatch.setattr(banking, "TRANSPORT", httpx.MockTransport(
        lambda r: httpx.Response(401, json={"message": "Invalid JWT", "error": "UNAUTHORIZED_ACCESS", "code": 401})
    ))
    r = client.post("/api/bank/test").json()
    assert r["ok"] is False and "Invalid JWT" in r["message"]


def test_connect_and_sync(client, household, bank):
    status = client.get("/api/bank/status").json()
    assert status["configured"] and status["app_id"] == APP_ID
    assert status["redirect_url"].endswith("/api/bank/callback")

    r = connect(client)
    assert r.status_code == 303 and "bank=connected" in r.headers["location"]
    # Asked for the bank's own maximum (90 days), not more.
    assert bank.auth["access"]["valid_until"].startswith((TODAY + timedelta(days=90)).isoformat())
    assert bank.auth["redirect_url"].endswith("/api/bank/callback")

    status = client.get("/api/bank/status").json()
    assert [a["name"] for a in status["accounts"]] == ["Budgetkonto", "Opsparing"]
    budget = status["accounts"][0]
    assert budget["balance"] == 10000  # CLBD preferred over ITAV
    # Pending transactions are skipped.
    txs = client.get("/api/bank/transactions", params={"year": TODAY.year, "month": TODAY.month}).json()
    assert [t["counterparty"] for t in txs] == ["Rema 1000"]
    assert txs[0]["amount"] == -500


def test_month_end_balances_from_bank(client, household, bank):
    main = next(a for a in household["accounts"] if a["kind"] == "main")
    connect(client)
    # The bank's main account took over the household's budget account.
    assert client.get("/api/bank/status").json()["accounts"][0]["account_id"] == main["id"]
    # End of last month: today's 10000 minus today's -500 = 10500.
    y, m = LAST_MONTH_END.year, LAST_MONTH_END.month
    s = client.get(f"/api/summary/{y}").json()
    acc = next(a for a in s["accounts"] if a["id"] == main["id"])
    assert acc["balances"][m - 1] == 10500
    assert acc["source"][m - 1] == "bank"
    # The month before: also undo last month's 129 and 12000 out.
    y2, m2 = TWO_MONTHS_END.year, TWO_MONTHS_END.month
    s2 = client.get(f"/api/summary/{y2}").json()
    acc2 = next(a for a in s2["accounts"] if a["id"] == main["id"])
    assert acc2["balances"][m2 - 1] == 10500 + 129 + 12000
    # A typed-in balance is not overwritten by the next sync.
    client.put(f"/api/accounts/{main['id']}/balance", json={"year": y, "month": m, "amount": 1})
    client.post("/api/bank/sync")
    s = client.get(f"/api/summary/{y}").json()
    acc = next(a for a in s["accounts"] if a["id"] == main["id"])
    assert acc["balances"][m - 1] == 1 and acc["source"][m - 1] == "manual"


def test_sorting_with_rules_and_actuals(client, household, bank):
    alex = next(m for m in household["members"] if m["name"] == "Alex")
    y, m = LAST_MONTH_END.year, LAST_MONTH_END.month
    netflix = client.post("/api/items", json={
        "member_id": alex["id"], "kind": "expense", "name": "Netflix", "year": y,
        "amounts": [129 if i == m - 1 else None for i in range(12)],
    }).json()
    connect(client)
    txs = client.get("/api/bank/transactions", params={"year": y, "month": m}).json()
    nflx = next(t for t in txs if t["counterparty"] == "NETFLIX.COM")
    assert nflx["suggestions"][0] == netflix["id"]  # same amount and the name matches
    assert nflx["pattern"] == "NETFLIX.COM"
    r = client.put(f"/api/bank/transactions/{nflx['id']}", json={"item_id": netflix["id"], "rule": "netflix"})
    assert r.status_code == 200
    items = client.get(f"/api/years/{y}/items").json()
    assert next(i for i in items if i["id"] == netflix["id"])["actual"][m - 1] == 129

    # The rule sorts it again after a fresh bank login (new ids for the same transactions).
    bank.budget_tx.append(tx("t5", LAST_MONTH_END, "129.00", "DBIT", "NETFLIX.COM", "Netflix again"))
    r = client.post("/api/bank/sync").json()
    assert r["new"] >= 1 and r["sorted"] == 1
    items = client.get(f"/api/years/{y}/items").json()
    assert next(i for i in items if i["id"] == netflix["id"])["actual"][m - 1] == 258

    # Ignoring with a rule.
    rent = next(t for t in txs if t["text"] == "Husleje")
    client.put(f"/api/bank/transactions/{rent['id']}", json={"ignored": True, "rule": "Husleje"})
    rules = client.get("/api/bank/status").json()["rules"]
    assert {r["pattern"]: r["ignore"] for r in rules} == {"netflix": False, "Husleje": True}


def test_manual_sync_sends_psu_headers(client, household, bank):
    connect(client)
    bank.requests.clear()
    client.post("/api/bank/sync", headers={"User-Agent": "phone"})
    account_calls = [r for r in bank.requests if "/accounts/" in r.url.path]
    assert account_calls and all(r.headers.get("Psu-User-Agent") == "phone" for r in account_calls)


def test_expired_session(client, household, bank, monkeypatch):
    connect(client)
    original = bank.handler

    def expired(request):
        if "/accounts/" in request.url.path:
            return httpx.Response(401, json={"message": "Session expired", "error": "EXPIRED_SESSION", "code": 401})
        return original(request)

    monkeypatch.setattr(banking, "TRANSPORT", httpx.MockTransport(expired))
    r = client.post("/api/bank/sync").json()
    assert r["errors"]
    assert client.get("/api/bank/status").json()["sessions"][0]["status"] == "expired"


def _accounts(client):
    return [a["name"] for a in client.get("/api/state").json()["accounts"]]


def test_disconnect_erases_its_accounts(client, household, bank):
    connect(client)
    client.delete("/api/bank/sessions/s1")
    status = client.get("/api/bank/status").json()
    assert status["sessions"] == [] and status["accounts"] == []
    assert _accounts(client) == []
    assert client.get("/api/bank/transactions", params={"year": TODAY.year, "month": TODAY.month}).json() == []


def test_account_removed_upstream_is_erased_on_sync(client, household, bank):
    connect(client)
    assert _accounts(client) == ["Budget account", "Savings"]
    bank.shared.discard("u-savings")  # unlinked in Enable Banking
    client.post("/api/bank/sync")
    assert [a["name"] for a in client.get("/api/bank/status").json()["accounts"]] == ["Budgetkonto"]
    assert _accounts(client) == ["Budget account"]


def test_account_removed_upstream_is_erased_on_new_login(client, household, bank):
    connect(client)
    bank.shared.discard("u-budget")  # not ticked at the bank this time
    connect(client)
    assert [a["name"] for a in client.get("/api/bank/status").json()["accounts"]] == ["Opsparing"]
    assert _accounts(client) == ["Savings"]
    assert client.get("/api/bank/transactions", params={"year": TODAY.year, "month": TODAY.month}).json() == []


def test_bank_accounts_are_not_deleted_in_the_app(client, household, bank):
    connect(client)
    acc = client.get("/api/state").json()["accounts"][0]
    r = client.delete(f"/api/accounts/{acc['id']}")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "BANK_ACCOUNT"
    # ...but can be renamed.
    client.patch(f"/api/accounts/{acc['id']}", json={"name": "Fælles budgetkonto"})
    assert _accounts(client)[0] == "Fælles budgetkonto"


def test_callback_rejects_unknown_state(client, household, bank):
    r = client.get("/api/bank/callback", params={"code": "good-code", "state": "forged"}, follow_redirects=False)
    assert "bank=error" in r.headers["location"]


def test_scheduled_sync_covers_every_budget(client, household, bank):
    from app import main

    connect(client)
    client.post("/api/logout")
    from tests.conftest import new_budget

    new_budget(client, login="other")  # no bank: must simply be skipped
    bank.requests.clear()
    main._scheduled_sync()  # not due yet: the callback just synced
    assert not bank.requests
    from app import db

    conn = db.open_budget(1)  # make the last sync look 7 hours old
    conn.execute("UPDATE bank_sessions SET last_sync = last_sync - 7 * 3600")
    conn.close()
    main._scheduled_sync()
    assert any("/accounts/" in r.url.path for r in bank.requests)


def test_suggested_rule_pattern_skips_what_changes():
    assert banking.suggest_pattern("", "Husleje oktober 2026") == "Husleje"
    assert banking.suggest_pattern("", "Overførsel Forbrugskonto") == "Overførsel Forbrugskonto"
    assert banking.suggest_pattern("NETFLIX.COM", "NETFLIX.COM 1234") == "NETFLIX.COM"


def test_bank_accounts_are_linked_automatically(client, household, bank):
    """Budgetkonto and Opsparing match the household's accounts by name; a
    third account gets a new Jetbuddy account of its own."""
    original = bank.handler

    def three_accounts(request):
        r = original(request)
        if request.url.path == "/sessions" and request.method == "POST":
            data = json.loads(r.content)
            data["accounts"].append({"uid": "u-joint", "account_id": {"iban": "DK2222"}, "name": "Fælleskonto", "currency": "DKK"})
            return httpx.Response(200, json=data)
        if "u-joint" in request.url.path:
            return original(httpx.Request(request.method, str(request.url).replace("u-joint", "u-savings"), headers=request.headers))
        return r

    import app.banking as b
    b.TRANSPORT = httpx.MockTransport(three_accounts)
    bank.shared.add("u-joint")
    connect(client)
    state = client.get("/api/state").json()
    names = {a["id"]: a["name"] for a in state["accounts"]}
    linked = {a["name"]: (names.get(a["account_id"]), a["track"]) for a in client.get("/api/bank/status").json()["accounts"]}
    # The test household's accounts are called "Budget account" and "Savings".
    assert linked["Budgetkonto"] == ("Budget account", True)
    assert linked["Opsparing"] == ("Savings", False)
    assert linked["Fælleskonto"] == ("Fælleskonto", True)
    assert [a["name"] for a in state["accounts"]] == ["Budget account", "Savings", "Fælleskonto"]


def test_each_bank_account_gets_its_own_account(client, household, bank):
    """Data from before: two bank accounts sharing one account, or one without."""
    connect(client)
    from app import db

    conn = db.open_budget(1)
    conn.execute("UPDATE bank_accounts SET account_id = (SELECT MIN(account_id) FROM bank_accounts)")
    conn.close()
    client.post("/api/bank/sync")
    ids = [a["account_id"] for a in client.get("/api/bank/status").json()["accounts"]]
    assert None not in ids and len(set(ids)) == 2
