import pytest
from fastapi.testclient import TestClient

from app import auth, db

PASSWORD = "correct horse"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(auth, "_failures", {})
    from app.main import app

    with TestClient(app) as c:
        yield c


def new_budget(client, login="test", members=("Alex", "Sam", "Kim", "Robin"), **extra):
    # The tests' household keeps the two accounts that new budgets used to start with.
    body = {"household": "Test", "members": list(members), "shared_name": "Shared", "login": login,
            "password": PASSWORD, "starter_accounts": True, **extra}
    return client.post("/api/budgets", json=body)


@pytest.fixture
def household(client):
    r = new_budget(client)
    assert r.status_code == 200, r.text
    return r.json()
