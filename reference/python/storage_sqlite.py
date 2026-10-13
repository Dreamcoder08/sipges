"""Explicit-path SQLite connections; path selection belongs to callers."""

import sqlite3
from os import PathLike


def connect_sqlite(
    path: str | PathLike[str], *, dictionary_rows: bool = False
) -> sqlite3.Connection:
    """Open with sqlite3 defaults, optionally exposing name-indexed rows.

    The caller owns the returned connection and must close it. Its native
    context manager commits or rolls back transactions but does not close it.
    No directory creation, path fallback, or scope resolution is performed.
    """
    connection = sqlite3.connect(path)
    if dictionary_rows:
        connection.row_factory = sqlite3.Row
    return connection
