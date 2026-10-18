import pytest

from app.importer import parse_number


@pytest.mark.parametrize(
    "text, value",
    [
        ("1234", 1234), ("-512,40", -512.40), ("1.234,50", 1234.5), ("1,234.50", 1234.5),
        ("1 234", 1234), ("1.234.567", 1234567), ("12,5", 12.5), ("1,234", 1234),
        ("kr. 99,95", 99.95), ("(500)", -500), ("", None), ("abc", None), (42, 42),
        # Danish thousands separators in text cells
        ("31.250", 31250), ("2.500", 2500), ("-10.184", -12000), ("31.250 kr.", 31250),
        ("\u22122.500", -2500), ("149.95", 149.95), ("1.5", 1.5),
    ],
)
def test_parse_number(text, value):
    assert parse_number(text) == value


@pytest.mark.parametrize(
    "text, decimal, value",
    [("1.234", ",", 1234), ("1.234", ".", 1.234), ("512,400", ",", 512.40), ("512,400", ".", 625920), ("31.250,00", ",", 31250)],
)
def test_parse_number_with_decimal_separator(text, decimal, value):
    assert parse_number(text, decimal) == value
