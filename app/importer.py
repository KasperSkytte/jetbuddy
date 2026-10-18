"""Read budget spreadsheets laid out as one row per item and one column per month.

This is how most people keep a household budget in Excel or Google Sheets:

            Jan    Feb    Mar   ...  Dec
    Salary  31250  34600  31250 ...  31250
    Rent    12450  12900  12300 ...  12000

Each sheet becomes a list of rows; the user then says per sheet whose it is and
whether it is income or expenses. Nothing is written here.
"""

import csv
import io
import re
import unicodedata

import openpyxl

from .db import round_cents

# Month names (and common abbreviations) in the languages people are most
# likely to keep a budget in. Matched on the first three letters, accents removed.
_MONTH_WORDS = [
    ["jan", "ene", "gen", "tam", "sty"],
    ["feb", "fev", "hel", "lut"],
    ["mar", "maa", "maal", "mrz"],
    ["apr", "avr", "abr", "huh", "kwi"],
    ["may", "maj", "mai", "mei", "mag", "tou"],
    ["jun", "jui", "gui", "kes", "cze"],
    ["jul", "jui", "lug", "hei", "lip"],
    ["aug", "aou", "ago", "elo", "sie"],
    ["sep", "set", "syy", "wrz"],
    ["oct", "okt", "out", "lok", "paz"],
    ["nov", "mar", "lis"],
    ["dec", "des", "dic", "dez", "jou", "gru"],
]


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return text.strip().lower()


def _month_of(header, position: int) -> int | None:
    """1-12 if this header cell names a month, else None.

    Some abbreviations are shared between months across languages ("mar" is
    March in English and November in Finnish), so a cell is only accepted for
    the month its position in the header row suggests, when that is ambiguous.
    """
    if header is None:
        return None
    if isinstance(header, (int, float)) and 1 <= header <= 12 and header == int(header):
        return int(header)
    if hasattr(header, "month"):  # a date cell
        return header.month
    word = _norm(header)[:3]
    if not word:
        return None
    if word.isdigit() and 1 <= int(word) <= 12:
        return int(word)
    matches = [i + 1 for i, words in enumerate(_MONTH_WORDS) if word in words]
    if len(matches) == 1:
        return matches[0]
    if position in matches:
        return position
    return matches[0] if matches else None


def parse_number(value, decimal: str = ",", both: str = "last", whole: str = "keep") -> float | None:
    """An amount from a spreadsheet cell. Real numbers are taken as they are.
    For text, decimal (',' or '.') is the decimal separator and everything
    else except digits and a leading minus is ignored: thousands separators,
    spaces, currency signs. (500) is negative, as in accounting.

    decimal 'either' takes comma or dot as the decimal separator. For a number
    with both, both='last' makes the last one the decimal separator and
    ignores the other (1.234,56 and 1,234.56 are both 1234.56); both='invalid'
    rejects it. More than one decimal separator is never valid.

    whole='only' accepts whole numbers only: nothing but the digits 0-9 (a
    number cell must be a whole number). Rounding is done by the caller."""
    if value is None or isinstance(value, bool):
        return None
    if whole == "only":
        if isinstance(value, (int, float)):
            return float(round(value)) if abs(value - round(value)) < 1e-6 else None
        text = str(value).strip()
        return float(text) if re.fullmatch(r"[0-9]+", text) else None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\u2212", "-").replace("\u2013", "-")
    negative = text.startswith("-") or (text.startswith("(") and text.endswith(")"))
    if decimal == "either":
        digits = re.sub(r"[^0-9,.]", "", text)
        if "," in digits and "." in digits:
            if both != "last":
                return None
            decimal = "," if digits.rfind(",") > digits.rfind(".") else "."
            digits = digits.replace("." if decimal == "," else ",", "")
        else:
            decimal = "," if "," in digits else "."
    else:
        digits = re.sub(r"[^0-9" + re.escape(decimal) + r"]", "", text)
    if not re.search(r"\d", digits) or digits.count(decimal) > 1 or re.search(r"[A-Za-z]{2,}", re.sub(r"(?i)kr\.?|dkk|sek|nok|eur|usd", "", text)):
        return None
    number = float(digits.replace(decimal, "."))
    return -number if negative else number


def other_decimal(text, decimal: str) -> bool:
    """True when text uses the other separator in a way only a decimal sign
    can be used: a thousands separator is always followed by exactly three
    digits, so "149,95" with dot as the decimal separator gives it away."""
    if decimal not in (",", ".") or not isinstance(text, str):
        return False
    other = "." if decimal == "," else ","
    s = re.sub(r"[^0-9,.]", "", text)
    if other not in s:
        return False
    return any(len(re.match(r"\d*", g).group()) != 3 for g in s.split(other)[1:])


def _parse_grid(name: str, grid: list[list], formulas: list[list] | None = None, decimal: str = ",", both: str = "last",
                whole: str = "keep") -> dict | None:
    """Find the month header row and read the rows below it."""
    header_row = None
    month_cols: dict[int, int] = {}
    for r, row in enumerate(grid[:15]):
        found = {}
        for c, cell in enumerate(row):
            if cell is None or str(cell).strip() == "":
                continue
            month = _month_of(cell, len(found) + 1)
            if month and month not in found.values():
                found[c] = month
        if len(found) >= 6:
            header_row, month_cols = r, found
            break
    if header_row is None:
        return None

    first_month_col = min(month_cols)
    rows = []
    suspects: list[str] = []  # text amounts that look like they use the other decimal sign
    unreadable: list[str] = []
    formula_cells = 0
    value_cells = 0
    for r in range(header_row + 1, len(grid)):
        row = grid[r]
        label = next(
            (str(v).strip() for v in row[:first_month_col] if v is not None and str(v).strip()),
            "",
        )
        if not label:
            continue
        values: list[float | None] = [None] * 12
        invalid: dict[int, str] = {}  # month -> the text that couldn't be read
        for c, month in month_cols.items():
            v = parse_number(row[c], decimal, both, whole) if c < len(row) else None
            if v is None and c < len(row) and re.search(r"\d", str(row[c] or "")) and not isinstance(row[c], bool):
                raw = row[c].strip() if isinstance(row[c], str) else str(row[c])
                unreadable.append(raw)  # has digits, but isn't a valid amount
                invalid[month] = raw[:100]
            if c < len(row) and other_decimal(row[c], decimal):
                suspects.append(str(row[c]).strip())
            is_formula = bool(formulas) and c < len(formulas[r]) and str(formulas[r][c] or "").startswith("=")
            if v is not None:
                values[month - 1] = v
            if v is not None or is_formula:
                value_cells += 1
                formula_cells += is_formula
        rows.append({"name": label[:200], "amounts": values, "invalid": invalid})

    if not rows:
        return None

    # Store amounts positive: an expenses sheet written with minus signs is
    # flipped, and the odd opposite-sign value (a refund) stays negative.
    signs = [v for row in rows for v in row["amounts"] if v]
    flip = sum(1 for v in signs if v < 0) > len(signs) / 2
    if flip:
        for row in rows:
            row["amounts"] = [None if v is None else -v for v in row["amounts"]]
    if whole in ("nearest", "up", "down"):
        for row in rows:
            row["amounts"] = [None if v is None else round_cents(round(v * 100), whole) / 100 for v in row["amounts"]]

    lowered = _norm(name)
    kind = None
    if re.search(r"\b(ind|income|indtaegt|inntekt|inkomst|einnahme)", lowered):
        kind = "income"
    elif re.search(r"\b(ud|udg|expense|cost|spend|utgift|ausgabe)", lowered) or flip:
        kind = "expense"

    return {
        "name": name,
        "rows": rows,
        "kind": kind,
        # Mostly formulas means a summary sheet (totals of the other sheets).
        "looks_like_summary": value_cells > 0 and formula_cells / value_cells > 0.5,
        "other_decimal": {"count": len(suspects), "example": suspects[0]} if suspects else None,
        "unreadable": {"count": len(unreadable), "example": unreadable[0]} if unreadable else None,
    }


def read_xlsx(data: bytes, decimal: str = ",", both: str = "last", whole: str = "keep") -> list[dict]:
    values_wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    formulas_wb = openpyxl.load_workbook(io.BytesIO(data), data_only=False, read_only=True)
    sheets = []
    for ws in values_wb.worksheets:
        grid = [list(row) for row in ws.iter_rows(values_only=True)]
        formulas = [list(row) for row in formulas_wb[ws.title].iter_rows(values_only=True)]
        parsed = _parse_grid(ws.title, grid, formulas, decimal, both, whole)
        if parsed:
            sheets.append(parsed)
    return sheets


def read_csv(data: bytes, name: str = "CSV", decimal: str = ",", both: str = "last", whole: str = "keep") -> list[dict]:
    text = data.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    grid = [row for row in csv.reader(io.StringIO(text), dialect)]
    parsed = _parse_grid(name, grid, decimal=decimal, both=both, whole=whole)
    return [parsed] if parsed else []


def read_file(filename: str, data: bytes, decimal: str = ",", both: str = "last", whole: str = "keep") -> list[dict]:
    if filename.lower().endswith((".xlsx", ".xlsm")):
        return read_xlsx(data, decimal, both, whole)
    return read_csv(data, filename.rsplit(".", 1)[0], decimal, both, whole)
