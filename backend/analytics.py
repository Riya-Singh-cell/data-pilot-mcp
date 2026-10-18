from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import sqlite3
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DATAPILOT_DB_PATH", ROOT / "data.sqlite"))
MAX_ROWS = 1000
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_COLUMNS = 280
IDENTIFIER = re.compile(r"[^a-zA-Z0-9_]+")


def connect(path: Path | None = None) -> sqlite3.Connection:
    connection = sqlite3.connect(path or DB_PATH, timeout=3)
    connection.row_factory = sqlite3.Row
    return connection


def connect_readonly() -> sqlite3.Connection:
    uri = f"{DB_PATH.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    return connection


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _normalized_name(value: str, index: int, seen: set[str]) -> str:
    name = IDENTIFIER.sub("_", value.strip()).strip("_").lower() or f"column_{index + 1}"
    if name[0].isdigit():
        name = f"column_{name}"
    base = name
    suffix = 2
    while name in seen:
        name = f"{base}_{suffix}"
        suffix += 1
    seen.add(name)
    return name


def _parse_value(value: str) -> Any:
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    value = value.strip()
    if not value:
        return None
    try:
        number = float(value.replace(",", "").replace("$", ""))
        if not math.isfinite(number):
            return value
        if number.is_integer():
            return int(number)
        return number
    except ValueError:
        return value


def _columns(connection: sqlite3.Connection, dataset_id: str) -> list[dict[str, Any]]:
    table = _table_name(dataset_id)
    rows = connection.execute(f"PRAGMA table_info({_quote(table)})").fetchall()
    return [{"name": row["name"], "type": row["type"] or "TEXT"} for row in rows]


def _table_name(dataset_id: str) -> str:
    record = uuid.UUID(dataset_id)
    return f"dataset_{record.hex}"


def _dataset(connection: sqlite3.Connection, dataset_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT id, name, row_count, column_count, uploaded_at FROM datasets WHERE id = ?",
        (dataset_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Dataset not found.")
    return row


def initialize() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS datasets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                table_name TEXT NOT NULL UNIQUE,
                row_count INTEGER NOT NULL,
                column_count INTEGER NOT NULL,
                uploaded_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS query_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset_id TEXT NOT NULL,
                query TEXT NOT NULL,
                executed_at TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                duration_ms REAL NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS saved_reports (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                dataset_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS dataset_lineage (
                dataset_id TEXT PRIMARY KEY,
                source_dataset_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('working_copy', 'saved_copy'))
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS dataset_working_copies (
                source_dataset_id TEXT PRIMARY KEY,
                working_dataset_id TEXT NOT NULL UNIQUE
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS editor_column_snapshots (
                token TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                column_name TEXT NOT NULL,
                column_type TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS editor_column_snapshot_values (
                token TEXT NOT NULL,
                row_id INTEGER NOT NULL,
                value_json TEXT,
                PRIMARY KEY (token, row_id)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS editor_transformation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                columns_json TEXT NOT NULL,
                affected_cells INTEGER NOT NULL,
                affected_rows INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        if connection.execute("SELECT 1 FROM datasets LIMIT 1").fetchone() is None:
            _seed_sample(connection)


def _seed_sample(connection: sqlite3.Connection) -> None:
    today = date.today()
    rows = []
    for offset in range(119, -1, -1):
        day = today - timedelta(days=offset)
        for order in range(1, 4):
            rows.append({
                "order_id": f"ORD-{offset:03}-{order}",
                "order_date": (day - timedelta(days=(order - 1) * 2)).isoformat(),
                "customer_id": f"CUST-{(offset * 3 + order) % 84:03}",
                "product": ("Analytics", "Platform", "Services")[(offset + order) % 3],
                "region": ("North America", "Europe", "APAC")[(offset + order) % 3],
                "revenue": round(180 + ((offset * 29 + order * 71) % 1420), 2),
            })
    create_dataset(connection, "sample_sales.csv", list(rows[0]), rows)


def create_dataset(
    connection: sqlite3.Connection,
    name: str,
    headers: list[str],
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    dataset_id = str(uuid.uuid4())
    table = _table_name(dataset_id)
    seen: set[str] = set()
    columns = [_normalized_name(header, index, seen) for index, header in enumerate(headers)]
    if not columns:
        raise ValueError("The CSV must contain a header row.")
    declarations = []
    for column in columns:
        values = [row.get(column) for row in rows]
        nonempty = [value for value in values if value is not None and str(value).strip()]
        numeric_values = []
        for value in nonempty:
            try:
                number = float(str(value).replace(",", "").replace("$", ""))
                if math.isfinite(number):
                    numeric_values.append(number)
            except ValueError:
                continue
        if nonempty and len(numeric_values) == len(nonempty):
            kind = "REAL" if any("." in str(value) for value in nonempty) else "INTEGER"
        elif nonempty and len(numeric_values) / len(nonempty) >= 0.8:
            kind = "REAL" if any(not number.is_integer() for number in numeric_values) else "INTEGER"
        else:
            kind = "TEXT"
        declarations.append(f"{_quote(column)} {kind}")
    connection.execute(f"CREATE TABLE {_quote(table)} ({', '.join(declarations)})")
    if rows:
        placeholders = ", ".join("?" for _ in columns)
        column_names = ", ".join(_quote(column) for column in columns)
        values = [
            tuple(_parse_value(row.get(header, "")) for header in headers)
            for row in rows
        ]
        connection.executemany(
            f"INSERT INTO {_quote(table)} ({column_names}) VALUES ({placeholders})",
            values,
        )
    uploaded_at = datetime.now(timezone.utc).isoformat()
    connection.execute(
        "INSERT INTO datasets VALUES (?, ?, ?, ?, ?, ?)",
        (dataset_id, name, table, len(rows), len(columns), uploaded_at),
    )
    return {
        "id": dataset_id,
        "name": name,
        "row_count": len(rows),
        "column_count": len(columns),
        "uploaded_at": uploaded_at,
        "status": "ready",
        "table_name": table,
    }


def ingest_csv(filename: str, content: bytes, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("File exceeds the 10 MB upload limit.")
    if Path(filename).suffix.lower() != ".csv":
        raise ValueError("Only CSV files are supported.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("CSV must use UTF-8 encoding.") from error
    try:
        records = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as error:
        raise ValueError(f"Malformed CSV: {error}") from error
    if not records or not records[0] or not any((header or "").strip() for header in records[0]):
        raise ValueError("CSV must contain a non-empty header row.")
    raw_headers = [header or "" for header in records[0]]
    if len(raw_headers) > MAX_COLUMNS:
        raise ValueError(f"CSV may contain at most {MAX_COLUMNS} columns.")
    if any(row and len(row) != len(raw_headers) for row in records[1:]):
        raise ValueError("CSV rows must have the same number of fields as the header.")
    seen: set[str] = set()
    headers = [_normalized_name(header, index, seen) for index, header in enumerate(raw_headers)]
    rows = [dict(zip(headers, row)) for row in records[1:] if row]
    own_connection = connection is None
    connection = connection or connect()
    try:
        result = create_dataset(connection, Path(filename).name[:160], headers, rows)
        if own_connection:
            connection.commit()
        return result
    finally:
        if own_connection:
            connection.close()


def list_datasets(connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        return [dict(row) | {"status": "ready"} for row in connection.execute(
            """SELECT d.id, d.name, d.row_count, d.column_count, d.uploaded_at,
                      l.source_dataset_id, l.role,
                      EXISTS (SELECT 1 FROM dataset_working_copies w WHERE w.working_dataset_id = d.id) AS is_working_copy
               FROM datasets d
               LEFT JOIN dataset_lineage l ON l.dataset_id = d.id
               ORDER BY d.uploaded_at DESC"""
        )]
    finally:
        if own_connection:
            connection.close()


def inspect_dataset(dataset_id: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        dataset = _dataset(connection, dataset_id)
        table = _table_name(dataset_id)
        columns = _columns(connection, dataset_id)
        sample = [dict(row) for row in connection.execute(
            f"SELECT * FROM {_quote(table)} LIMIT 5"
        )]
        return {
            "dataset": dict(dataset),
            "shape": {"rows": dataset["row_count"], "columns": dataset["column_count"]},
            "columns": columns,
            "sample": sample,
            "schema": {column["name"]: column["type"] for column in columns},
        }
    finally:
        if own_connection:
            connection.close()


def _resolve_column(columns: list[dict[str, Any]], candidates: tuple[str, ...]) -> str | None:
    by_name = {column["name"].lower(): column["name"] for column in columns}
    return next((by_name[name] for name in candidates if name in by_name), None)


def _fetch_records(connection: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
    return connection.execute(f"SELECT * FROM {_quote(table)} LIMIT ?", (MAX_ROWS + 1,)).fetchall()


def profile_data(dataset_id: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        dataset = _dataset(connection, dataset_id)
        table = _table_name(dataset_id)
        columns = _columns(connection, dataset_id)
        expressions = []
        date_column = _resolve_column(
            columns, ("date", "order_date", "created_at", "timestamp", "transaction_date")
        )
        for column in columns:
            name = _quote(column["name"])
            expressions.extend([
                f"SUM(CASE WHEN {name} IS NULL OR TRIM(CAST({name} AS TEXT)) = '' THEN 1 ELSE 0 END)",
                f"COUNT(DISTINCT NULLIF(TRIM(CAST({name} AS TEXT)), ''))",
                f"MIN(CASE WHEN typeof({name}) IN ('integer', 'real') THEN {name} END)" if column["type"] in ("INTEGER", "REAL") else "NULL",
                f"MAX(CASE WHEN typeof({name}) IN ('integer', 'real') THEN {name} END)" if column["type"] in ("INTEGER", "REAL") else "NULL",
                f"AVG(CASE WHEN typeof({name}) IN ('integer', 'real') THEN {name} END)" if column["type"] in ("INTEGER", "REAL") else "NULL",
                (
                    f"SUM(CASE WHEN {name} IS NOT NULL AND TRIM(CAST({name} AS TEXT)) != '' "
                    f"AND typeof({name}) NOT IN ('integer', 'real') THEN 1 ELSE 0 END)"
                    if column["type"] in ("INTEGER", "REAL") else "0"
                ),
                (
                    f"SUM(CASE WHEN {name} IS NOT NULL AND TRIM(CAST({name} AS TEXT)) != '' "
                    f"AND date({name}) IS NULL THEN 1 ELSE 0 END)"
                    if column["name"] == date_column else "0"
                ),
            ])
        summary = connection.execute(
            f"SELECT {', '.join(expressions)} FROM {_quote(table)}"
        ).fetchone()
        profiles = []
        row_count = dataset["row_count"]
        for index, column in enumerate(columns):
            missing = int(summary[index * 7] or 0)
            profiles.append({
                **column,
                "missing": missing,
                "missing_percent": round(missing / max(row_count, 1) * 100, 2),
                "unique": int(summary[index * 7 + 1] or 0),
                "statistics": {
                    "min": summary[index * 7 + 2],
                    "max": summary[index * 7 + 3],
                    "mean": round(summary[index * 7 + 4], 2) if summary[index * 7 + 4] is not None else None,
                },
                "type_inconsistencies": int(summary[index * 7 + 5] or 0),
                "invalid_dates": int(summary[index * 7 + 6] or 0),
            })
        sample = connection.execute(f"SELECT * FROM {_quote(table)} LIMIT 5").fetchall()
        return {"dataset_id": dataset_id, "columns": profiles, "sample": [dict(row) for row in sample]}
    finally:
        if own_connection:
            connection.close()


def quality_report(dataset_id: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        dataset = _dataset(connection, dataset_id)
        table = _table_name(dataset_id)
        row_count = dataset["row_count"]
        column_profiles = profile_data(dataset_id, connection)["columns"]
        missing_total = sum(column["missing"] for column in column_profiles)
        total_cells = max(row_count * len(column_profiles), 1)
        group_columns = ", ".join(_quote(column["name"]) for column in column_profiles)
        duplicate_count = connection.execute(
            f"SELECT COALESCE(SUM(duplicate_rows - 1), 0) FROM "
            f"(SELECT COUNT(*) AS duplicate_rows FROM {_quote(table)} GROUP BY {group_columns} HAVING COUNT(*) > 1)"
        ).fetchone()[0]
        issues = []
        for column in column_profiles:
            if column["missing"]:
                issues.append({
                    "type": "missing_values",
                    "column": column["name"],
                    "count": column["missing"],
                    "severity": "high" if column["missing_percent"] >= 20 else "medium",
                    "description": f"{column['missing_percent']}% of values are empty.",
                    "recommendation": "Investigate source completeness before imputing or excluding records.",
                })
            if column["type_inconsistencies"]:
                issues.append({
                    "type": "type_inconsistency",
                    "column": column["name"],
                    "count": column["type_inconsistencies"],
                    "severity": "medium",
                    "description": f"{column['type_inconsistencies']} non-numeric value(s) occur in a numeric column.",
                    "recommendation": "Review source values and correct or explicitly map non-numeric entries.",
                })
            if column["invalid_dates"]:
                issues.append({
                    "type": "invalid_dates",
                    "column": column["name"],
                    "count": column["invalid_dates"],
                    "severity": "medium",
                    "description": f"{column['invalid_dates']} non-empty value(s) are not valid dates.",
                    "recommendation": "Normalize date formats and verify invalid values with the source system.",
                })
        if duplicate_count:
            issues.append({
                "type": "duplicate_rows", "column": None, "count": duplicate_count,
                "severity": "medium", "description": f"{duplicate_count} duplicate records found.",
                "recommendation": "Review duplicate records against the source; original data is unchanged.",
            })
        anomaly_report = detect_anomalies(dataset_id, connection)
        if anomaly_report["anomalies"]:
            issues.append({
                "type": "statistical_outliers",
                "column": None,
                "count": len(anomaly_report["anomalies"]),
                "severity": "low",
                "description": f"{len(anomaly_report['anomalies'])} numeric outlier warning(s) flagged by z-score.",
                "recommendation": "Review these statistical warnings in source context; they are not proof of data errors.",
            })
        score = None if row_count == 0 else round(
            max(0, 100 * (1 - missing_total / total_cells) - min(duplicate_count / row_count * 100, 100)),
            1,
        )
        return {
            "dataset_id": dataset_id,
            "score": score,
            "row_count": row_count,
            "duplicate_count": duplicate_count,
            "missing_values": missing_total,
            "columns": column_profiles,
            "issues": issues,
            "outliers": anomaly_report["anomalies"],
            "calculation": (
                "Not available for an empty dataset. Otherwise: 100 × (1 − missing cells / total cells) "
                "− duplicate rows / rows × 100; bounded to 0–100."
            ),
        }
    finally:
        if own_connection:
            connection.close()


def metrics(
    dataset_id: str,
    days: int = 30,
    connection: sqlite3.Connection | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        _dataset(connection, dataset_id)
        table = _table_name(dataset_id)
        columns = _columns(connection, dataset_id)
        date_col = _resolve_column(columns, ("date", "order_date", "created_at", "timestamp", "transaction_date"))
        revenue_col = _resolve_column(columns, ("revenue", "amount", "sales", "net_revenue", "total"))
        customer_col = _resolve_column(columns, ("customer_id", "customer", "account_id", "client_id"))
        order_col = _resolve_column(columns, ("order_id", "transaction_id", "invoice_id"))
        today = date.today()

        current_start = date.fromisoformat(start_date) if start_date else today - timedelta(days=days - 1)
        current_end = date.fromisoformat(end_date) if end_date else today
        if current_end < current_start:
            raise ValueError("End date must be on or after start date.")
        days = (current_end - current_start).days + 1
        if days > 366:
            raise ValueError("Date range cannot exceed 366 days.")
        previous_start = current_start - timedelta(days=days)
        previous_end = current_start - timedelta(days=1)

        def summarize(start: date, end: date) -> dict[str, Any]:
            filters = ""
            params: tuple[str, ...] = ()
            if date_col:
                filters = f" WHERE date({_quote(date_col)}) BETWEEN date(?) AND date(?)"
                params = (start.isoformat(), end.isoformat())
            revenue_expr = f"SUM(CAST({_quote(revenue_col)} AS REAL))" if revenue_col else "NULL"
            customers_expr = f"COUNT(DISTINCT NULLIF({_quote(customer_col)}, ''))" if customer_col else "NULL"
            orders_expr = f"COUNT(DISTINCT NULLIF({_quote(order_col)}, ''))" if order_col else "NULL"
            row = connection.execute(
                f"SELECT {revenue_expr}, {customers_expr}, {orders_expr} FROM {_quote(table)}{filters}",
                params,
            ).fetchone()
            revenue_total = row[0]
            orders = int(row[2] or 0)
            return {
                "revenue": round(revenue_total or 0, 2) if revenue_col else None,
                "active_customers": int(row[1] or 0) if customer_col else None,
                "orders": orders if order_col else None,
                "average_order_value": round((revenue_total or 0) / max(orders, 1), 2) if revenue_col and order_col else None,
            }

        current_metrics = summarize(current_start, current_end)
        previous_metrics = summarize(previous_start, previous_end) if date_col else {
            key: None for key in current_metrics
        }
        comparison = {}
        for key, value in current_metrics.items():
            prior = previous_metrics[key]
            comparison[key] = {
                "absolute_change": round(value - prior, 2) if value is not None and prior is not None else None,
                "percent_change": round((value - prior) / abs(prior) * 100, 2) if value is not None and prior not in (None, 0) else None,
            }
        def daily_series(start: date, end: date) -> list[dict[str, Any]]:
            if not date_col or not revenue_col:
                return []
            series_rows = connection.execute(
                f"SELECT date({_quote(date_col)}) AS day, SUM(CAST({_quote(revenue_col)} AS REAL)) AS revenue "
                f"FROM {_quote(table)} WHERE date({_quote(date_col)}) BETWEEN date(?) AND date(?) "
                f"GROUP BY date({_quote(date_col)}) ORDER BY day",
                (start.isoformat(), end.isoformat()),
            )
            return [{"date": row["day"], "revenue": round(row["revenue"] or 0, 2)} for row in series_rows if row["day"]]

        series = daily_series(current_start, current_end)
        previous_series = daily_series(previous_start, previous_end)
        return {
            "dataset_id": dataset_id,
            "period": {"start": current_start.isoformat(), "end": current_end.isoformat(), "days": days},
            "metrics": current_metrics,
            "previous_period": {"start": previous_start.isoformat(), "end": previous_end.isoformat(), "metrics": previous_metrics},
            "comparison": comparison,
            "series": series,
            "previous_series": previous_series,
            "supported": {
                "revenue": revenue_col is not None,
                "customers": customer_col is not None,
                "orders": order_col is not None,
                "dates": date_col is not None,
            },
        }
    finally:
        if own_connection:
            connection.close()


def run_readonly_sql(dataset_id: str, query: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    if not query.strip():
        raise ValueError("Enter a SQL query.")
    if len(query) > 5000:
        raise ValueError("Query exceeds the 5,000 character limit.")
    own_connection = connection is None
    connection = connection or connect_readonly()
    try:
        dataset = _dataset(connection, dataset_id)
        allowed = _table_name(dataset_id)
        denied_reason: str | None = None
        timed_out = False
        deadline = time.monotonic() + 2
        safe_functions = {
            "abs", "avg", "coalesce", "count", "date", "ifnull", "length",
            "lower", "max", "min", "nullif", "round", "strftime", "substr",
            "sum", "total", "trim", "upper",
        }

        def authorizer(action: int, arg1: str | None, arg2: str | None, _db: str | None, _source: str | None) -> int:
            nonlocal denied_reason
            if action == sqlite3.SQLITE_SELECT:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and arg1 == allowed:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() in safe_functions:
                return sqlite3.SQLITE_OK
            denied_reason = "table" if action == sqlite3.SQLITE_READ else (
                "function" if action == sqlite3.SQLITE_FUNCTION else "write"
            )
            return sqlite3.SQLITE_DENY

        def progress() -> int:
            nonlocal timed_out
            if time.monotonic() > deadline:
                timed_out = True
                return 1
            return 0

        # A separate read-only handle plus SQLite's authorizer prevents data changes and cross-dataset access.
        connection.set_authorizer(authorizer)
        connection.set_progress_handler(progress, 10000)
        started = datetime.now(timezone.utc)
        cursor = connection.execute(query)
        if cursor.description is None:
            raise ValueError("Only read-only SELECT queries are allowed.")
        records = cursor.fetchmany(MAX_ROWS + 1)
        if len(records) > MAX_ROWS:
            raise ValueError(f"Query returned more than the {MAX_ROWS} row limit; add a LIMIT clause.")
        duration_ms = round((datetime.now(timezone.utc) - started).total_seconds() * 1000, 2)
        return {
            "columns": [item[0] for item in cursor.description],
            "rows": [dict(row) for row in records],
            "row_count": len(records),
            "duration_ms": duration_ms,
            "truncated": False,
        }
    except (sqlite3.DatabaseError, sqlite3.Warning) as error:
        message = str(error)
        if timed_out:
            raise ValueError("Query exceeded the 2-second execution timeout.") from error
        if denied_reason == "table":
            raise ValueError("Query may reference only the selected dataset.") from error
        if denied_reason == "function":
            raise ValueError("Query uses a SQL function that is not permitted.") from error
        if denied_reason == "write" or "not authorized" in message.lower():
            raise ValueError("Only read-only SELECT queries are allowed.") from error
        raise ValueError(f"SQL error: {message}") from error
    finally:
        try:
            connection.set_authorizer(None)
            connection.set_progress_handler(None, 0)
        except sqlite3.Error:
            pass
        if own_connection:
            connection.close()


def detect_anomalies(
    dataset_id: str,
    connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect_readonly()
    try:
        dataset = _dataset(connection, dataset_id)
        table = _table_name(dataset_id)
        columns = _columns(connection, dataset_id)
        findings = []
        scanned = 0
        for column in columns:
            if column["type"] not in ("INTEGER", "REAL"):
                continue
            name = _quote(column["name"])
            values = connection.execute(
                f"SELECT {name} FROM {_quote(table)} WHERE {name} IS NOT NULL AND typeof({name}) IN ('integer', 'real')"
            )
            count = 0
            mean = 0.0
            sum_squared_deviations = 0.0
            for (raw_value,) in values:
                observed = float(raw_value)
                count += 1
                delta = observed - mean
                mean += delta / count
                sum_squared_deviations += delta * (observed - mean)
            if count < 4:
                continue
            deviation = (sum_squared_deviations / count) ** 0.5
            if deviation:
                for (raw_value,) in connection.execute(
                    f"SELECT {name} FROM {_quote(table)} WHERE {name} IS NOT NULL AND typeof({name}) IN ('integer', 'real')"
                ):
                    observed = float(raw_value)
                    z_score = (observed - mean) / deviation
                    if abs(z_score) >= 3:
                        scanned += 1
                        findings.append({
                            "column": column["name"], "observed_value": observed,
                            "z_score": round(z_score, 2), "method": "z-score (|z| >= 3)",
                            "explanation": "This value is at least three population standard deviations from the column mean.",
                        })
                        if scanned >= 100:
                            break
            if scanned >= 100:
                break
        return {
            "dataset_id": dataset_id,
            "rows_scanned": dataset["row_count"],
            "method": "population z-score (|z| >= 3), capped at 100 returned findings",
            "anomalies": findings,
        }
    finally:
        if own_connection:
            connection.close()


def search_dataset(dataset_id: str, term: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    own_connection = connection is None
    connection = connection or connect()
    try:
        table = _table_name(dataset_id)
        columns = _columns(connection, dataset_id)
        needle = term.strip().lower()
        if not needle:
            raise ValueError("Search term cannot be empty.")
        escaped = needle.replace("~", "~~").replace("%", "~%").replace("_", "~_")
        clauses = [f"CAST({_quote(column['name'])} AS TEXT) LIKE ? ESCAPE '~'" for column in columns]
        rows = connection.execute(
            f"SELECT * FROM {_quote(table)} WHERE {' OR '.join(clauses)} LIMIT 101",
            tuple(f"%{escaped}%" for _ in columns),
        ).fetchall()
        return {
            "dataset_id": dataset_id,
            "term": term,
            "matches": [dict(row) for row in rows[:100]],
            "count": min(len(rows), 100),
            "truncated": len(rows) > 100,
        }
    finally:
        if own_connection:
            connection.close()


def compare_periods(dataset_id: str, days: int = 30) -> dict[str, Any]:
    result = metrics(dataset_id, days)
    return {
        "period": result["period"],
        "previous_period": result["previous_period"],
        "current_metrics": result["metrics"],
        "changes": result["comparison"],
        "caveat": None if result["supported"]["dates"] else "No date column detected; period comparison is unavailable and all rows are used for current totals.",
    }


def record_sql_history(dataset_id: str, query: str, result: dict[str, Any]) -> None:
    with connect() as connection:
        connection.execute(
            "INSERT INTO query_history (dataset_id, query, executed_at, row_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (dataset_id, query, datetime.now(timezone.utc).isoformat(), result["row_count"], result["duration_ms"]),
        )


def sql_history(dataset_id: str | None = None) -> list[dict[str, Any]]:
    with connect() as connection:
        if dataset_id:
            rows = connection.execute(
                "SELECT dataset_id, query, executed_at, row_count, duration_ms FROM query_history WHERE dataset_id = ? ORDER BY id DESC LIMIT 50",
                (dataset_id,),
            )
        else:
            rows = connection.execute(
                "SELECT dataset_id, query, executed_at, row_count, duration_ms FROM query_history ORDER BY id DESC LIMIT 50"
            )
        return [dict(row) for row in rows]


def export_csv(rows: list[dict[str, Any]], columns: list[str] | None = None) -> str:
    output = io.StringIO(newline="")
    fieldnames = columns or (list(rows[0]) if rows else [])
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    if fieldnames:
        writer.writeheader()
        writer.writerows(rows)
    return output.getvalue()
