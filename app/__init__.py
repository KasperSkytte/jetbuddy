import os

__version__ = "0.2.0"


def env(name: str, default: str | None = None) -> str | None:
    """A setting from the environment: SPAREGRISEN_<name>."""
    return os.environ.get(f"SPAREGRISEN_{name}", default)
