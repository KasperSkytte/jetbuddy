import pytest

from app.importer import parse_number


@pytest.mark.parametrize(
    "text, decimal, value",
    [
        # comma as the decimal separator: dots and everything else are ignored
        ("1234", ",", 1234), ("-512,40", ",", -512.40), ("1.234,50", ",", 1234.5), ("31.250", ",", 31250),
        ("2.500", ",", 2500), ("1.234.567", ",", 1234567), ("1 234,5", ",", 1234.5), ("31.250 kr.", ",", 31250),
        ("kr. 99,95", ",", 99.95), ("\u22122.500", ",", -2500), ("(500)", ",", -500), ("12,5", ",", 12.5),
        # dot as the decimal separator
        ("1,234.50", ".", 1234.5), ("149.95", ".", 149.95), ("2,500", ".", 2500), ("-12,000", ".", -12000),
        # not amounts
        ("", ",", None), ("abc", ",", None), ("Jan", ",", None), ("1,2,3", ",", None), ("1.2.3", ".", None),
        # real numbers in the spreadsheet are taken as they are
        (42, ",", 42), (149.95, ".", 149.95),
    ],
)
def test_parse_number(text, decimal, value):
    assert parse_number(text, decimal) == value
