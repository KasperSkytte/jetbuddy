import pytest

from app.importer import parse_number


@pytest.mark.parametrize(
    "text, value",
    [
        ("1234", 1234), ("-512,40", -512.40), ("1.234,50", 1234.5), ("1,234.50", 1234.5),
        ("1 234", 1234), ("1.234.567", 1234567), ("12,5", 12.5), ("1,234", 1234),
        ("kr. 99,95", 99.95), ("(500)", -500), ("", None), ("abc", None), (42, 42),
    ],
)
def test_parse_number(text, value):
    assert parse_number(text) == value
