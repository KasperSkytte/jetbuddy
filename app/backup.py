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


# schema -> what turns a backup of that schema into the next one. Steps that
# only added tables or columns need nothing: restoring fills in the defaults.
STEPS = {5: _expense_accounts}


def upgrade(data: dict, schema: int) -> dict:
    """data as a backup of the current schema, in the current format."""
    version = int(data.get("schema", 0))
    for v in range(version, schema):
        if v in STEPS:
            STEPS[v](data)
    data["format"], data["schema"] = "sparegrisen", schema
    return data
