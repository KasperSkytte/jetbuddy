"""Bringing a backup from an older version up to date before it is restored.

A backup is the JSON from /api/export: {"format", "schema", <table>: [rows]}.
"schema" is how many migrations the database had, so each step below turns
a backup of one schema into the next, like db.MIGRATIONS does for a database.
"""

# The app was called Jetbuddy before; its backups are the same thing.
FORMATS = ("sparegrisen", "jetbuddy")


def _expense_accounts(data: dict) -> None:
    """Schema 6 has expense accounts, and only one budget account."""
    accounts = sorted(data.get("accounts", []), key=lambda a: (a.get("sort", 0), a.get("id", 0)))
    main_seen = False
    for a in accounts:
        a.setdefault("in_overview", 1)
        if a.get("kind") == "main":
            if main_seen:
                a["kind"], a["in_overview"] = "expense", 0
            main_seen = True


def _one_rule_each(data: dict) -> None:
    """Schema 9 keeps one rule per text and item: a rule goes when a newer one
    has the same text and the same item, or the same amount (as db.MIGRATIONS)."""
    rules = data.get("bank_rules", [])
    text = lambda r: (r.get("pattern") or "").strip().lower()
    replaces = lambda n, r: n.get("id", 0) > r.get("id", 0) and text(n) == text(r) and (
        (n.get("item_id") == r.get("item_id") and n.get("ignore") == r.get("ignore")) or n.get("amount_cents") == r.get("amount_cents"))
    data["bank_rules"] = [r for r in rules if not any(replaces(n, r) for n in rules)]


# schema -> what turns a backup of that schema into the next one. Steps that
# only added tables or columns need nothing: restoring fills in the defaults.
STEPS = {5: _expense_accounts, 8: _one_rule_each}


def upgrade(data: dict, schema: int) -> dict:
    """data as a backup of the current schema, in the current format."""
    version = int(data.get("schema", 0))
    for v in range(version, schema):
        if v in STEPS:
            STEPS[v](data)
    data["format"], data["schema"] = "sparegrisen", schema
    return data
