import pytest
from fastapi.testclient import TestClient

from app import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.delenv("JETBUDDY_PASSWORD", raising=False)
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def household(client):
    r = client.post(
        "/api/setup",
        json={"household": "Test", "members": ["Alex", "Sam", "Kim", "Robin"], "shared_name": "Shared"},
    )
    assert r.status_code == 200, r.text
    return r.json()
