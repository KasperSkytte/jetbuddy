import os

__version__ = "0.1.0"


def env(name: str, default: str | None = None) -> str | None:
    """A setting from the environment: SPAREGRISEN_<name>, or JETBUDDY_<name>
    as the app was called before."""
    return os.environ.get(f"SPAREGRISEN_{name}", os.environ.get(f"JETBUDDY_{name}", default))
