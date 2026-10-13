"""SQLite ownership contracts using only temporary synthetic databases."""

import sqlite3

import pytest

from storage_sqlite import connect_sqlite


@pytest.mark.parametrize("dictionary_rows", [False, True])
def test_row_shape_and_sqlite_defaults(tmp_path, dictionary_rows):
    db = connect_sqlite(tmp_path / "rows.db", dictionary_rows=dictionary_rows)
    try:
        row = db.execute("SELECT 7 AS id, 'synthetic' AS marker").fetchone()
        if dictionary_rows:
            assert isinstance(row, sqlite3.Row)
            assert dict(row) == {"id": 7, "marker": "synthetic"}
            assert row[0] == 7
        else:
            assert type(row) is tuple
            assert row == (7, "synthetic")
        assert db.isolation_level == ""
        assert db.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    finally:
        db.close()


def test_explicit_paths_isolate_same_table_and_id(tmp_path):
    paths = [tmp_path / "first.db", tmp_path / "second.db"]
    for path, marker in zip(paths, ["first-only", "second-only"]):
        db = connect_sqlite(path)
        try:
            with db:
                db.execute("CREATE TABLE records (id INTEGER PRIMARY KEY, marker TEXT)")
                db.execute("INSERT INTO records VALUES (?, ?)", (1, marker))
        finally:
            db.close()

    for path, marker in zip(paths, ["first-only", "second-only"]):
        db = connect_sqlite(path, dictionary_rows=True)
        try:
            rows = db.execute("SELECT id, marker FROM records").fetchall()
            assert [dict(row) for row in rows] == [{"id": 1, "marker": marker}]
        finally:
            db.close()


def test_context_commit_persists_after_reopen(tmp_path):
    path = tmp_path / "commit.db"
    db = connect_sqlite(path)
    try:
        with db:
            db.execute("CREATE TABLE records (id INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO records VALUES (1)")
    finally:
        db.close()

    reopened = connect_sqlite(str(path))
    try:
        assert reopened.execute("SELECT id FROM records").fetchall() == [(1,)]
    finally:
        reopened.close()


def test_context_exception_rolls_back(tmp_path):
    path = tmp_path / "rollback.db"
    db = connect_sqlite(path)
    try:
        with db:
            db.execute("CREATE TABLE records (id INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO records VALUES (1)")
        with pytest.raises(RuntimeError, match="synthetic failure"):
            with db:
                db.execute("INSERT INTO records VALUES (2)")
                raise RuntimeError("synthetic failure")
        assert db.execute("SELECT id FROM records").fetchall() == [(1,)]
    finally:
        db.close()

    reopened = connect_sqlite(path)
    try:
        assert reopened.execute("SELECT id FROM records").fetchall() == [(1,)]
    finally:
        reopened.close()


def test_context_manager_does_not_close_connection(tmp_path):
    db = connect_sqlite(tmp_path / "lifetime.db")
    try:
        with db:
            assert db.execute("SELECT 1").fetchone() == (1,)
        assert db.execute("SELECT 2").fetchone() == (2,)
        with pytest.raises(ValueError):
            with db:
                raise ValueError("synthetic exception")
        assert db.execute("SELECT 3").fetchone() == (3,)
    finally:
        db.close()
    with pytest.raises(sqlite3.ProgrammingError):
        db.execute("SELECT 4")
