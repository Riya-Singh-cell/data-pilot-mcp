from __future__ import annotations

import csv
import ast
import io
import json
import math
import re
import sqlite3
import uuid
import statistics
import operator
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from backend import analytics

MAX_PAGE_SIZE = 200
MAX_OPERATIONS = 500
MAX_COLUMNS = analytics.MAX_COLUMNS
SQL_TYPES = {"TEXT", "INTEGER", "REAL", "BOOLEAN", "DATE"}
MAX_TRANSFORM_CHANGES = 100_000
TRANSFORM_BATCH_SIZE = 10_000
SAFE_SUFFIX = re.compile(r"\.csv$", re.IGNORECASE)
DEFAULT_MISSING_MARKERS = ("N/A", "NA", "null", "None")
_EXPRESSION_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}


def _column_info(connection: sqlite3.Connection, dataset_id: str) -> list[dict[str, str]]:
    return analytics._columns(connection, dataset_id)


def _existing_column(name: Any, column_map: dict[str, Any]) -> bool:
    return isinstance(name, str) and name in column_map


def _rowid_name(columns: list[dict[str, Any]]) -> str:
    names = {column["name"].lower() for column in columns}
    for candidate in ("rowid", "_rowid_", "oid"):
        if candidate not in names:
            return candidate
    raise ValueError("This dataset uses all reserved SQLite row identifiers and cannot be edited safely.")


def _editor_row_key(columns: list[dict[str, Any]]) -> str:
    existing = {column["name"] for column in columns}
    name = "__datapilot_editor_row_id__"
    while name in existing:
        name = f"_{name}"
    return name


def _safe_name(name: str) -> str:
    basename = Path(name.strip()).name
    basename = SAFE_SUFFIX.sub("", basename).strip()
    if not basename or basename in {".", ".."}:
        raise ValueError("Enter a valid dataset name.")
    return f"{basename[:155]}.csv"


def _renamed_column_name(value: str, index: int = 0) -> str:
    name = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip()).strip("_") or f"column_{index + 1}"
    if name[0].isdigit():
        name = f"column_{name}"
    return name


def _unique_name(connection: sqlite3.Connection, name: str) -> str:
    normalized = _safe_name(name)
    stem = normalized[:-4]
    candidate = normalized
    suffix = 2
    while connection.execute("SELECT 1 FROM datasets WHERE lower(name) = lower(?)", (candidate,)).fetchone():
        marker = f" ({suffix})"
        candidate = f"{stem[:155 - len(marker)]}{marker}.csv"
        suffix += 1
    return candidate


def _source_for(connection: sqlite3.Connection, dataset_id: str) -> str:
    analytics._dataset(connection, dataset_id)
    source = connection.execute(
        "SELECT source_dataset_id FROM dataset_lineage WHERE dataset_id = ? AND role = 'working_copy'",
        (dataset_id,),
    ).fetchone()
    if source:
        return source["source_dataset_id"]
    mapping = connection.execute(
        "SELECT source_dataset_id FROM dataset_working_copies WHERE working_dataset_id = ?",
        (dataset_id,),
    ).fetchone()
    return mapping["source_dataset_id"] if mapping else dataset_id


def _clone_dataset(
    connection: sqlite3.Connection,
    source_id: str,
    name: str,
    role: str,
) -> dict[str, Any]:
    source = analytics._dataset(connection, source_id)
    source_columns = _column_info(connection, source_id)
    if not source_columns:
        raise ValueError("A dataset without columns cannot be copied.")
    dataset_id = str(uuid.uuid4())
    target_table = analytics._table_name(dataset_id)
    source_table = analytics._quote(analytics._table_name(source_id))
    definitions = ", ".join(
        f"{analytics._quote(column['name'])} {column['type'] or 'TEXT'}"
        for column in source_columns
    )
    connection.execute(f"CREATE TABLE {analytics._quote(target_table)} ({definitions})")
    rowid = _rowid_name(source_columns)
    names = ", ".join(analytics._quote(column["name"]) for column in source_columns)
    connection.execute(
        f"INSERT INTO {analytics._quote(target_table)} ({rowid}, {names}) "
        f"SELECT {rowid}, {names} FROM {source_table} ORDER BY {rowid}"
    )
    timestamp = datetime.now(timezone.utc).isoformat()
    copied_name = _unique_name(connection, name)
    connection.execute(
        "INSERT INTO datasets (id, name, table_name, row_count, column_count, uploaded_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (dataset_id, copied_name, target_table, source["row_count"], len(source_columns), timestamp),
    )
    connection.execute(
        "INSERT INTO dataset_lineage (dataset_id, source_dataset_id, role) VALUES (?, ?, ?)",
        (dataset_id, source_id, role),
    )
    return {
        "id": dataset_id,
        "name": copied_name,
        "row_count": source["row_count"],
        "column_count": len(source_columns),
        "uploaded_at": timestamp,
        "status": "ready",
        "source_dataset_id": source_id,
        "role": role,
        "is_working_copy": role == "working_copy",
    }


def ensure_working_copy(dataset_id: str) -> dict[str, Any]:
    with analytics.connect() as connection:
        source_id = _source_for(connection, dataset_id)
        existing = connection.execute(
            """SELECT d.id, d.name, d.row_count, d.column_count, d.uploaded_at
               FROM dataset_working_copies w JOIN datasets d ON d.id = w.working_dataset_id
               WHERE w.source_dataset_id = ?""",
            (source_id,),
        ).fetchone()
        if existing:
            return dict(existing) | {
                "status": "ready", "source_dataset_id": source_id,
                "role": "working_copy", "is_working_copy": True,
            }
        source = analytics._dataset(connection, dataset_id)
        name = f"{SAFE_SUFFIX.sub('', source['name'])}_edited.csv"
        copied = _clone_dataset(connection, dataset_id, name, "working_copy")
        connection.execute(
            "INSERT INTO dataset_working_copies (source_dataset_id, working_dataset_id) VALUES (?, ?)",
            (dataset_id, copied["id"]),
        )
        return copied


def editor_records(
    dataset_id: str,
    offset: int = 0,
    limit: int = 100,
    search: str = "",
    sort: str | None = None,
    direction: str = "asc",
    filter_column: str | None = None,
    filter_value: str = "",
) -> dict[str, Any]:
    if offset < 0 or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError(f"Offset must be non-negative and limit must be from 1 to {MAX_PAGE_SIZE}.")
    if direction not in {"asc", "desc"}:
        raise ValueError("Sort direction must be asc or desc.")
    with analytics.connect_readonly() as connection:
        dataset = analytics._dataset(connection, dataset_id)
        columns = _column_info(connection, dataset_id)
        rowid = _rowid_name(columns)
        row_key = _editor_row_key(columns)
        table = analytics._quote(analytics._table_name(dataset_id))
        conditions: list[str] = []
        params: list[Any] = []
        term = search.strip()
        if term:
            escaped = term.replace("~", "~~").replace("%", "~%").replace("_", "~_")
            conditions.append("(" + " OR ".join(
                f"CAST({analytics._quote(column['name'])} AS TEXT) LIKE ? ESCAPE '~'"
                for column in columns
            ) + ")")
            params.extend([f"%{escaped}%"] * len(columns))
        if filter_value.strip():
            if filter_column not in {column["name"] for column in columns}:
                raise ValueError("Filter field does not exist in this dataset.")
            escaped = filter_value.strip().replace("~", "~~").replace("%", "~%").replace("_", "~_")
            conditions.append(f"CAST({analytics._quote(filter_column)} AS TEXT) LIKE ? ESCAPE '~'")
            params.append(f"%{escaped}%")
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        total = connection.execute(f"SELECT COUNT(*) FROM {table}{where}", params).fetchone()[0]
        if sort:
            if sort not in {column["name"] for column in columns}:
                raise ValueError("Sort field does not exist in this dataset.")
            order = f" ORDER BY {analytics._quote(sort)} {direction.upper()}, {rowid} ASC"
        else:
            order = f" ORDER BY {rowid} ASC"
        rows = connection.execute(
            f"SELECT {rowid} AS {analytics._quote(row_key)}, * FROM {table}{where}{order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        return {
            "dataset": dict(dataset),
            "columns": columns,
            "row_key": row_key,
            "total": total,
            "offset": offset,
            "limit": limit,
            "rows": [dict(row) for row in rows],
        }


def _missing(value: Any, markers: list[str] | set[str]) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    if isinstance(value, str):
        stripped = value.strip()
        missing_markers = markers if isinstance(markers, set) else {marker.strip().casefold() for marker in markers}
        return not stripped or stripped.casefold() in missing_markers
    return False


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _evaluate_expression(expression: str, values: dict[str, Any], columns: set[str]) -> float | None:
    try:
        root = ast.parse(expression, mode="eval").body
    except SyntaxError as error:
        raise ValueError("Enter a valid arithmetic expression using column names.") from error

    def evaluate(node: ast.AST) -> float | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return float(node.value)
        if isinstance(node, ast.Name):
            if node.id not in columns:
                raise ValueError(f"Expression references unknown column '{node.id}'.")
            return _as_number(values[node.id])
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand)
            if value is None:
                return None
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and type(node.op) in _EXPRESSION_OPERATORS:
            left, right = evaluate(node.left), evaluate(node.right)
            if left is None or right is None:
                return None
            if isinstance(node.op, ast.Pow) and abs(right) > 10:
                raise ValueError("Expression exponent must be between -10 and 10.")
            try:
                result = _EXPRESSION_OPERATORS[type(node.op)](left, right)
            except (ArithmeticError, OverflowError) as error:
                raise ValueError(f"Expression cannot be evaluated: {error}") from error
            if not isinstance(result, (int, float)) or not math.isfinite(result):
                raise ValueError("Expression produced a non-finite number.")
            return result
        raise ValueError("Expressions support only column names, numeric constants, and +, -, *, /, //, %, and **.")

    return evaluate(root)


def _condition_matches(value: Any, condition: dict[str, Any], markers: list[str] | set[str], data_type: str) -> bool:
    operator = condition.get("operator")
    target = condition.get("value", "")
    if operator == "is empty":
        return _missing(value, markers)
    if operator == "is not empty":
        return not _missing(value, markers)
    if operator == "contains":
        if value is None:
            return False
        left = str(value)
        right = str(target)
        if not condition.get("match_case", False):
            left, right = left.casefold(), right.casefold()
        return right in left
    if operator in {"greater than", "greater than or equal", "less than", "less than or equal"}:
        left_number = _as_number(value)
        right_number = _as_number(target)
        if left_number is None or right_number is None:
            return False
        return {
            "greater than": left_number > right_number,
            "greater than or equal": left_number >= right_number,
            "less than": left_number < right_number,
            "less than or equal": left_number <= right_number,
        }[operator]
    if data_type in {"INTEGER", "REAL"}:
        left_number, right_number = _as_number(value), _as_number(target)
        if left_number is not None and right_number is not None:
            return left_number == right_number if operator == "equals" else left_number != right_number
    left, right = str(value), str(target)
    if not condition.get("match_case", True):
        left, right = left.casefold(), right.casefold()
    return left == right if operator == "equals" else left != right


def _transform_value(value: Any, transform: dict[str, Any], column_type: str, markers: list[str] | set[str]) -> Any:
    kind = transform.get("kind")
    if kind == "replace":
        if transform.get("match_mode", "exact") not in {"exact", "contains"}:
            raise ValueError("Choose exact matching or contains-text matching.")
        if not isinstance(transform.get("replace_all", True), bool):
            raise ValueError("Replace-all must be true or false.")
        find = transform.get("find", "")
        replacement = transform.get("replacement", "")
        if value is None:
            matched = find == ""
        elif column_type in {"INTEGER", "REAL"} and transform.get("match_mode", "exact") == "exact":
            left, right = _as_number(value), _as_number(find)
            matched = left is not None and right is not None and left == right
        elif transform.get("match_mode", "exact") == "contains":
            if not find:
                raise ValueError("Contains matching requires a non-empty search value.")
            left, right = str(value), str(find)
            if not transform.get("match_case", False):
                left, right = left.casefold(), right.casefold()
            matched = right in left
        else:
            left, right = str(value), str(find)
            if not transform.get("match_case", True):
                left, right = left.casefold(), right.casefold()
            matched = left == right
        return (True, replacement) if matched else (False, value)
    if kind == "fill_missing":
        if not _missing(value, markers):
            return False, value
        mode = transform.get("fill_mode", "value")
        if mode == "value":
            return True, transform.get("replacement")
        return True, transform["_fill_values"][transform["_fill_key"]]
    if kind == "bulk_update":
        condition = transform["condition"]
        if _condition_matches(value, condition, markers, column_type):
            return True, transform.get("replacement")
        return False, value
    if kind == "column":
        if value is None:
            return False, value
        action = transform.get("action")
        if action == "trim":
            next_value = str(value).strip()
        elif action == "normalize":
            next_value = str(value).strip().lower()
        elif action == "uppercase":
            next_value = str(value).upper()
        elif action == "lowercase":
            next_value = str(value).lower()
        elif action == "round":
            number = _as_number(value)
            if number is None:
                return False, value
            digits = transform.get("digits", 0)
            next_value = round(number, digits)
            if column_type == "INTEGER":
                next_value = int(next_value)
        else:
            raise ValueError("Unsupported column transformation.")
        return next_value != value, next_value
    if kind == "clean_missing_markers":
        if isinstance(value, str) and value.strip().casefold() in {marker.casefold() for marker in markers}:
            return True, None
        return False, value
    raise ValueError("Unsupported transformation.")


def _chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def _transform_operations(
    changes: list[dict[str, Any]],
    removed_rows: list[dict[str, Any]],
    rowid_to_ui: dict[int, int | str],
    trailing_operation: dict[str, Any] | None = None,
    leading_inverse: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    operations: list[dict[str, Any]] = []
    inverses: list[dict[str, Any]] = []
    for batch in _chunked(changes, TRANSFORM_BATCH_SIZE):
        operations.append({"type": "set_cells", "cells": [
            {"row_id": rowid_to_ui.get(change["row_id"], change["row_id"]),
             "column": change["column"], "value": change["value"]}
            for change in batch
        ]})
        inverses.insert(0, {"type": "set_cells", "cells": [
            {"row_id": rowid_to_ui.get(change["row_id"], change["row_id"]),
             "column": change["column"], "value": change["previous"]}
            for change in batch
        ]})
    for batch in _chunked(removed_rows, 2000):
        operations.append({"type": "delete_rows", "row_ids": [
            rowid_to_ui.get(row["id"], row["id"]) for row in batch
        ]})
        for inverse_batch in reversed(_chunked(batch, 1000)):
            inverses.insert(0, {"type": "insert_rows", "rows": [
                {"id": rowid_to_ui.get(row["id"], row["id"]), "values": row["values"]}
                for row in inverse_batch
            ]})
    if trailing_operation:
        operations.append(trailing_operation)
    if leading_inverse:
        inverses.insert(0, leading_inverse)
    return operations, inverses


def preview_transformation(
    dataset_id: str,
    transform: dict[str, Any],
    pending_operations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not isinstance(transform, dict):
        raise ValueError("A transformation must be an object.")
    pending_operations = pending_operations or []
    if len(pending_operations) > MAX_OPERATIONS:
        raise ValueError(f"Preview supports at most {MAX_OPERATIONS} pending edit operations.")
    kind = transform.get("kind")
    markers = transform.get("markers", list(DEFAULT_MISSING_MARKERS))
    if not isinstance(markers, list) or len(markers) > 50 or any(not isinstance(item, str) for item in markers):
        raise ValueError("Missing-value markers must be a list of at most 50 strings.")
    markers = {item.strip().casefold() for item in markers if item.strip()}
    if kind not in {"replace", "fill_missing", "bulk_update", "column", "convert_type", "clean_missing_markers", "remove_missing_rows", "remove_duplicates"}:
        if kind not in {"rename_column", "split_column", "combine_columns", "calculate_column", "remove_missing_columns", "flag_range"}:
            raise ValueError("Unsupported transformation.")

    with analytics.connect() as connection:
        analytics._dataset(connection, dataset_id)
        if pending_operations:
            pending = _apply_batch(connection, dataset_id, pending_operations)
            temporary_row_map = pending["row_id_map"]
        else:
            temporary_row_map = {}

        columns = _column_info(connection, dataset_id)
        column_map = {column["name"]: column for column in columns}
        rowid = _rowid_name(columns)
        table = analytics._quote(analytics._table_name(dataset_id))
        transform = dict(transform)
        selected = transform.get("columns")
        if kind in {"replace", "bulk_update"}:
            if kind == "replace":
                if transform.get("match_mode", "exact") not in {"exact", "contains"}:
                    raise ValueError("Choose exact matching or contains-text matching.")
                if not isinstance(transform.get("replace_all", True), bool):
                    raise ValueError("Replace-all must be true or false.")
                if not isinstance(transform.get("find"), str) or not transform["find"]:
                    if not (isinstance(transform.get("find"), str) and _missing(transform["find"], markers)):
                        raise ValueError("Enter a value to find.")
                if not isinstance(transform.get("replacement"), str):
                    raise ValueError("Replacement must be text.")
                if transform.get("column") == "*":
                    target_columns = list(column_map)
                else:
                    target_columns = [transform.get("column")]
                transform["kind"] = "replace"
            else:
                target_columns = [transform.get("target_column")]
                condition = transform.get("condition")
                if not isinstance(condition, dict) or condition.get("operator") not in {
                    "equals", "not equals", "greater than", "greater than or equal",
                    "less than", "less than or equal", "contains", "is empty", "is not empty",
                }:
                    raise ValueError("Choose a supported condition.")
                condition_column = condition.get("column")
                if not _existing_column(condition_column, column_map):
                    raise ValueError("Condition column does not exist in this dataset.")
                transform["_condition_column"] = condition_column
        elif kind in {"fill_missing", "clean_missing_markers", "remove_missing_rows"}:
            if kind == "fill_missing":
                raw_column = transform.get("column")
                candidates = list(column_map) if raw_column == "*" else raw_column if isinstance(raw_column, list) else [raw_column]
                if any(not _existing_column(name, column_map) for name in candidates):
                    raise ValueError("Select one or more existing columns.")
                mode = transform.get("fill_mode", "value")
                if raw_column == "*":
                    if mode in {"mean", "median"}:
                        candidates = [
                            name for name in candidates
                            if column_map[name]["type"].upper() in {"INTEGER", "REAL"}
                        ]
                    elif mode == "value":
                        replacement = transform.get("replacement")
                        candidates = [
                            name for name in candidates
                            if _can_validate_value(replacement, column_map[name]["type"].upper(), name)
                        ]
                target_columns = candidates
                transform["_fill_values"] = {}
                transform["_fill_key"] = ""
            else:
                raw_column = transform.get("column")
                target_columns = list(column_map) if raw_column is None or raw_column == "*" else [raw_column]
        elif kind in {"column", "convert_type"}:
            target_columns = selected
            if kind == "convert_type" and str(transform.get("target_type", "")).upper() not in SQL_TYPES:
                raise ValueError("Choose TEXT, INTEGER, REAL, BOOLEAN, or DATE as the target type.")
            if kind == "column" and transform.get("action") not in {"trim", "normalize", "uppercase", "lowercase", "round"}:
                raise ValueError("Choose a supported column transformation.")
            if kind == "column" and transform.get("action") == "round" and (not isinstance(transform.get("digits", 0), int) or not -10 <= transform.get("digits", 0) <= 10):
                raise ValueError("Rounding digits must be a whole number between -10 and 10.")
        elif kind == "rename_column":
            source = transform.get("column")
            if not _existing_column(source, column_map):
                raise ValueError("Select an existing column to rename.")
            target_columns = [source]
            raw_name = transform.get("new_name")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Enter a name for the renamed column.")
            new_name = _renamed_column_name(raw_name)
            if any(name.casefold() == new_name.casefold() and name != source for name in column_map):
                raise ValueError(f"Column '{new_name}' already exists.")
            transform["_new_name"] = new_name
        elif kind == "split_column":
            source = transform.get("column")
            delimiter = transform.get("delimiter")
            if not _existing_column(source, column_map):
                raise ValueError("Select an existing column to split.")
            if not isinstance(delimiter, str) or not delimiter:
                raise ValueError("Enter a non-empty delimiter.")
            raw_names = [transform.get("first_name"), transform.get("second_name")]
            new_names = [analytics._normalized_name(value, index, set()) for index, value in enumerate(raw_names) if isinstance(value, str)]
            if len(new_names) != 2 or any(not isinstance(value, str) or not value.strip() for value in raw_names):
                raise ValueError("Enter names for both split columns.")
            if len(set(new_names)) != 2 or set(new_names) & set(column_map):
                raise ValueError("Split column names must be unique and different from existing columns.")
            target_columns = [source]
            transform["_new_columns"] = [{"name": name, "type": "TEXT"} for name in new_names]
        elif kind == "combine_columns":
            source_columns = transform.get("columns")
            delimiter = transform.get("delimiter", "")
            if (
                not isinstance(source_columns, list)
                or len(source_columns) < 2
                or any(not isinstance(name, str) for name in source_columns)
                or len(set(source_columns)) != len(source_columns)
                or any(not _existing_column(name, column_map) for name in source_columns)
            ):
                raise ValueError("Select at least two existing columns to combine.")
            if not isinstance(delimiter, str):
                raise ValueError("The combine delimiter must be text.")
            raw_name = transform.get("new_name")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Enter a name for the combined column.")
            new_name = analytics._normalized_name(raw_name, 0, set())
            if new_name in column_map:
                raise ValueError(f"Column '{new_name}' already exists.")
            target_columns = source_columns
            transform["_new_columns"] = [{"name": new_name, "type": "TEXT"}]
        elif kind == "calculate_column":
            expression = transform.get("expression")
            raw_name = transform.get("new_name")
            if not isinstance(expression, str) or not expression.strip():
                raise ValueError("Enter a calculation using numeric column names.")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Enter a name for the calculated column.")
            new_name = analytics._normalized_name(raw_name, 0, set())
            if new_name in column_map:
                raise ValueError(f"Column '{new_name}' already exists.")
            try:
                expression_tree = ast.parse(expression, mode="eval")
            except SyntaxError as error:
                raise ValueError("Enter a valid arithmetic expression using column names.") from error
            references = {node.id for node in ast.walk(expression_tree) if isinstance(node, ast.Name)}
            if references - set(column_map):
                raise ValueError(f"Expression references unknown columns: {', '.join(sorted(references - set(column_map)))}.")
            target_columns = sorted(references)
            transform["_new_columns"] = [{"name": new_name, "type": "REAL"}]
        elif kind == "flag_range":
            source = transform.get("column")
            if not _existing_column(source, column_map) or column_map[source]["type"].upper() not in {"INTEGER", "REAL"}:
                raise ValueError("Select a numeric column to validate.")
            minimum = transform.get("minimum")
            maximum = transform.get("maximum")
            if minimum is None and maximum is None:
                raise ValueError("Enter a minimum, maximum, or both for the numeric range.")
            try:
                minimum = float(minimum) if minimum is not None else None
                maximum = float(maximum) if maximum is not None else None
            except (TypeError, ValueError) as error:
                raise ValueError("Range limits must be finite numbers.") from error
            if any(value is not None and not math.isfinite(value) for value in (minimum, maximum)):
                raise ValueError("Range limits must be finite numbers.")
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError("The minimum range limit must not exceed the maximum.")
            raw_name = transform.get("new_name")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Enter a name for the review-flag column.")
            new_name = analytics._normalized_name(raw_name, 0, set())
            if new_name in column_map:
                raise ValueError(f"Column '{new_name}' already exists.")
            target_columns = [source]
            transform["_minimum"] = minimum
            transform["_maximum"] = maximum
            transform["_new_columns"] = [{"name": new_name, "type": "TEXT"}]
        elif kind == "remove_missing_columns":
            target_columns = list(column_map)
        else:
            target_columns = list(column_map)
        if not isinstance(target_columns, list) or (not target_columns and kind != "calculate_column") or any(not _existing_column(column, column_map) for column in target_columns):
            raise ValueError("Select one or more existing columns.")

        preview_warnings: list[str] = []
        if kind == "fill_missing":
            mode = transform.get("fill_mode", "value")
            if mode not in {"value", "mean", "median", "mode"}:
                raise ValueError("Choose a valid missing-value fill method.")
            if not target_columns:
                raise ValueError("No selected columns can use this missing-value fill method.")
            for name in target_columns:
                column_type = column_map[name]["type"].upper()
                if mode in {"mean", "median"} and column_type not in {"INTEGER", "REAL"}:
                    raise ValueError(f"{mode.title()} can only fill numeric columns ({name} is {column_type}).")
                if mode == "mode":
                    values = [
                        row[0] for row in connection.execute(
                            f"SELECT {analytics._quote(name)} FROM {table}"
                        ).fetchall() if not _missing(row[0], markers)
                    ]
                    if not values:
                        raise ValueError(f"Cannot determine a mode for empty column '{name}'.")
                    counts: dict[str, tuple[int, Any]] = {}
                    for item in values:
                        key = str(item)
                        count, _ = counts.get(key, (0, item))
                        counts[key] = (count + 1, item)
                    fill_value = sorted(counts.values(), key=lambda item: (-item[0], str(item[1])))[0][1]
                    transform["_fill_values"][name] = fill_value
                elif mode in {"mean", "median"}:
                    nums = [
                        number for (value,) in connection.execute(
                            f"SELECT {analytics._quote(name)} FROM {table}"
                        ).fetchall()
                        if not _missing(value, markers) and (number := _as_number(value)) is not None
                    ]
                    if not nums:
                        raise ValueError(f"Cannot calculate {mode} for column '{name}'.")
                    fill_value = sum(nums) / len(nums) if mode == "mean" else statistics.median(nums)
                    if column_type == "INTEGER" and not float(fill_value).is_integer():
                        fill_value = int(round(fill_value))
                        preview_warnings.append(
                            f"{mode.title()} imputation for integer column '{name}' was rounded to the nearest whole number."
                        )
                    transform["_fill_values"][name] = _validated_value(fill_value, column_type, name)
                else:
                    transform["_fill_values"][name] = _validated_value(
                        transform.get("replacement"), column_type, name,
                    )

        row_key = _editor_row_key(columns)
        query = connection.execute(
            f"SELECT {rowid} AS {analytics._quote(row_key)}, * FROM {table} ORDER BY {rowid}"
        )
        reverse_row_map = {new_id: original for original, new_id in temporary_row_map.items()}
        changes: list[dict[str, Any]] = []
        removed_rows: list[dict[str, Any]] = []
        examples: list[dict[str, Any]] = []
        affected_rows: set[int] = set()
        schema_operation = None
        schema_inverse = None
        new_columns = transform.get("_new_columns", [])
        removed_columns: list[str] = []
        rename_operation = None
        if kind == "convert_type":
            name = target_columns[0]
            target_type = str(transform["target_type"]).upper()
            old_type = column_map[name]["type"].upper()
            if old_type != target_type:
                schema_operation = {"type": "convert_column", "name": name, "column_type": target_type}
                schema_inverse = {"type": "convert_column", "name": name, "column_type": old_type}
        elif kind == "rename_column":
            if target_columns[0] != transform["_new_name"]:
                rename_operation = {
                    "type": "rename_column",
                    "old_name": target_columns[0],
                    "name": transform["_new_name"],
                }
        elif kind == "remove_missing_columns":
            rows_for_columns = connection.execute(
                f"SELECT * FROM {table} ORDER BY {rowid}"
            )
            while True:
                rows_batch = rows_for_columns.fetchmany(TRANSFORM_BATCH_SIZE)
                if not rows_batch:
                    break
                for item in rows_batch:
                    row_values = dict(item)
                    removed_columns.extend(
                        name for name in column_map
                        if name not in removed_columns and _missing(row_values[name], markers)
                    )
            if len(removed_columns) >= len(column_map):
                raise ValueError("This operation would remove every column. Keep at least one column.")
            if removed_columns and len(examples) < 20:
                examples.extend({
                    "row_id": "",
                    "column": name,
                    "before": "Column contains missing values",
                    "after": "Column removed",
                } for name in removed_columns[:20])
        marker_warnings = 0
        seen_rows: set[tuple[Any, ...]] = set()
        while True:
            batch = query.fetchmany(TRANSFORM_BATCH_SIZE)
            if not batch:
                break
            for row in batch:
                if kind == "replace" and not transform.get("replace_all", True) and changes:
                    break
                row_id = row[row_key]
                current = dict(row)
                if kind == "remove_duplicates":
                    signature = tuple(current[column] for column in column_map)
                    if signature in seen_rows:
                        removed_rows.append({
                            "id": row_id,
                            "values": {name: current[name] for name in column_map},
                        })
                        affected_rows.add(row_id)
                        if len(examples) < 20:
                            examples.append({
                                "row_id": reverse_row_map.get(row_id, row_id),
                                "column": "(row)",
                                "before": {name: current[name] for name in list(column_map)[:4]},
                                "after": "Row removed",
                            })
                        continue
                    seen_rows.add(signature)
                    continue
                if kind == "remove_missing_columns":
                    continue
                if kind == "rename_column":
                    continue
                if kind in {"split_column", "combine_columns", "calculate_column", "flag_range"}:
                    output_values: dict[str, Any]
                    if kind == "split_column":
                        source_value = current[target_columns[0]]
                        pieces = str(source_value).split(transform["delimiter"], 1) if source_value is not None else ["", ""]
                        output_values = {
                            transform["_new_columns"][0]["name"]: pieces[0],
                            transform["_new_columns"][1]["name"]: pieces[1] if len(pieces) > 1 else "",
                        }
                    elif kind == "combine_columns":
                        output_values = {
                            transform["_new_columns"][0]["name"]: str(transform["delimiter"]).join(
                                "" if current[name] is None else str(current[name]) for name in target_columns
                            ),
                        }
                    elif kind == "calculate_column":
                        calculated = _evaluate_expression(
                            transform["expression"], current, set(column_map),
                        )
                        output_values = {transform["_new_columns"][0]["name"]: calculated}
                    else:
                        number = _as_number(current[target_columns[0]])
                        minimum, maximum = transform["_minimum"], transform["_maximum"]
                        is_outside = number is not None and (
                            (minimum is not None and number < minimum)
                            or (maximum is not None and number > maximum)
                        )
                        output_values = {
                            transform["_new_columns"][0]["name"]: "Review" if is_outside else None,
                        }
                    for name, new_value in output_values.items():
                        if new_value is None:
                            continue
                        changes.append({
                            "row_id": row_id, "column": name, "value": new_value, "previous": None,
                        })
                        affected_rows.add(row_id)
                        if len(examples) < 20:
                            examples.append({
                                "row_id": reverse_row_map.get(row_id, row_id),
                                "column": name, "before": None, "after": new_value,
                            })
                    continue
                if kind == "remove_missing_rows":
                    has_missing = any(_missing(current[name], markers) for name in target_columns)
                    if has_missing:
                        removed_rows.append({
                            "id": row_id,
                            "values": {name: current[name] for name in column_map},
                        })
                        affected_rows.add(row_id)
                        if len(examples) < 20:
                            examples.append({
                                "row_id": reverse_row_map.get(row_id, row_id),
                                "column": "(row)",
                                "before": {name: current[name] for name in list(column_map)[:4]},
                                "after": "Row removed",
                            })
                    continue
                if kind == "bulk_update":
                    condition_column = transform["_condition_column"]
                    if not _condition_matches(
                        current[condition_column], transform["condition"], markers,
                        column_map[condition_column]["type"].upper(),
                    ):
                        continue
                    name = target_columns[0]
                    proposed = transform.get("replacement")
                    new_value = _validated_value(proposed, column_map[name]["type"].upper(), name)
                    if new_value != current[name]:
                        changes.append({
                            "row_id": row_id, "column": name, "value": new_value, "previous": current[name],
                        })
                        affected_rows.add(row_id)
                        if len(examples) < 20:
                            examples.append({
                                "row_id": reverse_row_map.get(row_id, row_id),
                                "column": name,
                                "before": current[name],
                                "after": new_value,
                            })
                    continue
                if kind == "convert_type":
                    name = target_columns[0]
                    try:
                        new_value = _convert_value(current[name], str(transform["target_type"]).upper(), name)
                    except ValueError as error:
                        raise ValueError(f"Row {reverse_row_map.get(row_id, row_id)}: {error}") from error
                    if new_value != current[name]:
                        changes.append({
                            "row_id": row_id, "column": name, "value": new_value, "previous": current[name],
                        })
                        affected_rows.add(row_id)
                        if len(examples) < 20:
                            examples.append({
                                "row_id": reverse_row_map.get(row_id, row_id),
                                "column": name, "before": current[name], "after": new_value,
                            })
                    continue
                for name in target_columns:
                    transform["_fill_key"] = name
                    matched, new_value = _transform_value(current[name], transform, column_map[name]["type"].upper(), markers)
                    if kind == "clean_missing_markers" and matched:
                        marker_warnings += 1
                    if not matched:
                        continue
                    try:
                        new_value = _validated_value(new_value, column_map[name]["type"].upper(), name)
                    except ValueError:
                        raise
                    if new_value == current[name]:
                        continue
                    changes.append({
                        "row_id": row_id, "column": name, "value": new_value, "previous": current[name],
                    })
                    affected_rows.add(row_id)
                    if len(examples) < 20:
                        examples.append({
                            "row_id": reverse_row_map.get(row_id, row_id),
                            "column": name,
                            "before": current[name],
                            "after": new_value,
                        })
                    if len(changes) + len(removed_rows) > MAX_TRANSFORM_CHANGES:
                        raise ValueError(
                            f"This transformation affects more than {MAX_TRANSFORM_CHANGES:,} records. "
                            "Filter the dataset or narrow the selected columns first."
                        )
            if kind == "replace" and not transform.get("replace_all", True) and changes:
                break

        if len(changes) + len(removed_rows) > MAX_TRANSFORM_CHANGES:
            raise ValueError(
                f"This transformation affects more than {MAX_TRANSFORM_CHANGES:,} records. "
                "Filter the dataset or narrow the selected columns first."
            )
        operations, inverse_operations = _transform_operations(
            changes, removed_rows, reverse_row_map, schema_operation, schema_inverse,
        )
        if new_columns:
            operations = [
                {"type": "add_column", "name": column["name"], "column_type": column["type"]}
                for column in new_columns
            ] + operations
            inverse_operations.extend(
                {"type": "delete_column", "name": column["name"]}
                for column in reversed(new_columns)
            )
        if rename_operation:
            operations = [rename_operation]
            inverse_operations = [{
                "type": "rename_column",
                "old_name": rename_operation["name"],
                "name": rename_operation["old_name"],
            }]
        if removed_columns:
            operations = [{"type": "delete_column", "name": name} for name in removed_columns]
            inverse_operations = [
                {"type": "add_column", "name": name, "column_type": column_map[name]["type"]}
                for name in reversed(removed_columns)
            ]
        connection.rollback()
        if new_columns:
            result_columns = [column["name"] for column in new_columns]
        elif rename_operation:
            result_columns = [rename_operation["name"]]
        elif removed_columns:
            result_columns = removed_columns
        else:
            result_columns = target_columns
        return {
            "kind": kind,
            "columns": result_columns,
            "columns_added": [column["name"] for column in new_columns],
            "columns_removed": removed_columns,
            "affected_cells": len(changes),
            "affected_rows": len(affected_rows),
            "rows_removed": len(removed_rows),
            "type_changes": ([{
                "column": target_columns[0],
                "from": schema_inverse["column_type"],
                "to": schema_operation["column_type"],
            }] if schema_operation and schema_inverse else []),
            "examples": examples,
            "warnings": preview_warnings + (
                [f"{marker_warnings} configured missing-value markers will be converted to NULL."]
                if marker_warnings else []
            ),
            "operations": operations,
            "inverse_operations": inverse_operations,
        }


def _resolve_row_id(value: Any, row_id_map: dict[str, int]) -> int:
    if isinstance(value, str) and value in row_id_map:
        return row_id_map[value]
    if isinstance(value, bool):
        raise ValueError("Row identifiers must be positive integers.")
    try:
        row_id = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Row identifier is invalid or references an unsaved row.") from error
    if row_id <= 0:
        raise ValueError("Row identifiers must be positive integers.")
    return row_id


def _validated_value(value: Any, sql_type: str, column: str) -> Any:
    if value is None or value == "":
        return None
    if sql_type == "TEXT":
        return str(value)
    if sql_type == "BOOLEAN":
        if isinstance(value, bool):
            return int(value)
        normalized = str(value).strip().casefold()
        if normalized in {"true", "1", "yes", "y"}:
            return 1
        if normalized in {"false", "0", "no", "n"}:
            return 0
        raise ValueError(f"'{value}' is not a valid boolean for '{column}' (use true/false, yes/no, or 1/0).")
    if sql_type == "DATE":
        try:
            return date.fromisoformat(str(value).strip()).isoformat()
        except ValueError as error:
            raise ValueError(f"'{value}' is not a valid ISO date for '{column}'.") from error
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"'{value}' is not a valid {sql_type.lower()} value for '{column}'.") from error
    if not math.isfinite(number):
        raise ValueError(f"'{value}' is not a finite number for '{column}'.")
    if sql_type == "INTEGER":
        if not number.is_integer():
            raise ValueError(f"'{value}' must be a whole number for '{column}'.")
        return int(number)
    return number


def _can_validate_value(value: Any, sql_type: str, column: str) -> bool:
    try:
        _validated_value(value, sql_type, column)
        return True
    except ValueError:
        return False


def _convert_value(value: Any, target_type: str, column: str) -> Any:
    try:
        return _validated_value(value, target_type, column)
    except ValueError as error:
        raise ValueError(f"Cannot convert column '{column}' value {value!r} to {target_type}: {error}") from error


def _apply_batch(connection: sqlite3.Connection, dataset_id: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
    copy = connection.execute(
        "SELECT source_dataset_id FROM dataset_lineage WHERE dataset_id = ? AND role = 'working_copy'",
        (dataset_id,),
    ).fetchone()
    if copy is None:
        raise ValueError("Changes can only be saved to an editor working copy.")
    table = analytics._quote(analytics._table_name(dataset_id))
    row_id_map: dict[str, int] = {}
    inverse: list[dict[str, Any]] = []
    normalized: list[dict[str, Any]] = []

    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("Each edit operation must be an object.")
        kind = operation.get("type")
        columns = _column_info(connection, dataset_id)
        names = {column["name"] for column in columns}
        rowid = _rowid_name(columns)

        if kind == "set_cells":
            cells = operation.get("cells")
            if not isinstance(cells, list) or not 1 <= len(cells) <= 10_000:
                raise ValueError("A cell edit must contain between 1 and 10,000 cells.")
            previous = []
            updates = []
            for cell in cells:
                column = cell.get("column")
                if column not in names:
                    raise ValueError(f"Column '{column}' does not exist in this dataset.")
                row_id = _resolve_row_id(cell.get("row_id"), row_id_map)
                old = connection.execute(
                    f"SELECT {analytics._quote(column)} FROM {table} WHERE {rowid} = ?", (row_id,)
                ).fetchone()
                if old is None:
                    raise ValueError(f"Row {row_id} no longer exists.")
                sql_type = next(item["type"] for item in columns if item["name"] == column)
                value = _validated_value(cell.get("value"), sql_type, column)
                previous.append({"row_id": row_id, "column": column, "value": old[0]})
                updates.append((value, row_id, column))
            for value, row_id, column in updates:
                connection.execute(
                    f"UPDATE {table} SET {analytics._quote(column)} = ? WHERE {rowid} = ?",
                    (value, row_id),
                )
            inverse.append({"type": "set_cells", "cells": previous})
            normalized.append({"type": "set_cells", "cells": [
                {"row_id": _resolve_row_id(cell["row_id"], row_id_map), "column": cell["column"],
                 "value": _validated_value(cell.get("value"), next(item["type"] for item in columns if item["name"] == cell["column"]), cell["column"])}
                for cell in cells
            ]})

        elif kind == "insert_rows":
            rows = operation.get("rows")
            if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
                raise ValueError("Insert between 1 and 1,000 rows at a time.")
            inserted_ids = []
            normalized_rows = []
            column_names = [column["name"] for column in columns]
            for item in rows:
                values = item.get("values", {})
                if not isinstance(values, dict) or set(values) - names:
                    raise ValueError("New rows may only contain fields from the current dataset.")
                parsed = {
                    name: _validated_value(
                        values.get(name),
                        next(column["type"] for column in columns if column["name"] == name),
                        name,
                    )
                    for name in column_names
                }
                requested_id = item.get("id")
                if isinstance(requested_id, int) and not isinstance(requested_id, bool):
                    row_id = _resolve_row_id(requested_id, row_id_map)
                    exists = connection.execute(f"SELECT 1 FROM {table} WHERE {rowid} = ?", (row_id,)).fetchone()
                    if exists:
                        raise ValueError(f"Row {row_id} already exists.")
                    quoted_columns = ", ".join([rowid, *(analytics._quote(name) for name in column_names)])
                    placeholders = ", ".join("?" for _ in range(len(column_names) + 1))
                    connection.execute(
                        f"INSERT INTO {table} ({quoted_columns}) VALUES ({placeholders})",
                        (row_id, *(parsed[name] for name in column_names)),
                    )
                else:
                    quoted_columns = ", ".join(analytics._quote(name) for name in column_names)
                    placeholders = ", ".join("?" for _ in column_names)
                    cursor = connection.execute(
                        f"INSERT INTO {table} ({quoted_columns}) VALUES ({placeholders})",
                        tuple(parsed[name] for name in column_names),
                    )
                    row_id = cursor.lastrowid
                    if isinstance(requested_id, str):
                        row_id_map[requested_id] = row_id
                inserted_ids.append(row_id)
                normalized_rows.append({"id": row_id, "values": parsed})
            inverse.append({"type": "delete_rows", "row_ids": inserted_ids})
            normalized.append({"type": "insert_rows", "rows": normalized_rows})

        elif kind == "delete_rows":
            ids = operation.get("row_ids")
            if not isinstance(ids, list) or not 1 <= len(ids) <= 2000:
                raise ValueError("Select between 1 and 2,000 rows to delete.")
            removed = []
            for item in ids:
                row_id = _resolve_row_id(item, row_id_map)
                row = connection.execute(
                    f"SELECT {rowid} AS row_id, * FROM {table} WHERE {rowid} = ?", (row_id,)
                ).fetchone()
                if row is None:
                    raise ValueError(f"Row {row_id} no longer exists.")
                removed.append({"id": row[0], "values": {name: row[name] for name in names}})
            connection.executemany(f"DELETE FROM {table} WHERE {rowid} = ?", [(item["id"],) for item in removed])
            inverse.append({"type": "insert_rows", "rows": removed})
            normalized.append({"type": "delete_rows", "row_ids": [item["id"] for item in removed]})

        elif kind == "add_column":
            if len(columns) >= MAX_COLUMNS:
                raise ValueError(f"A dataset may contain at most {MAX_COLUMNS} columns.")
            raw_name = operation.get("name")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Column name must not be empty.")
            name = analytics._normalized_name(raw_name, len(columns), set())
            if name in names:
                raise ValueError(f"Column '{name}' already exists.")
            sql_type = str(operation.get("column_type", "TEXT")).upper()
            if sql_type not in SQL_TYPES:
                raise ValueError("New columns must use TEXT, INTEGER, or REAL.")
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {analytics._quote(name)} {sql_type}")
            inverse.append({"type": "delete_column", "name": name})
            normalized.append({"type": "add_column", "name": name, "column_type": sql_type})

        elif kind == "delete_column":
            name = operation.get("name")
            if name not in names:
                raise ValueError(f"Column '{name}' does not exist in this dataset.")
            if len(columns) <= 1:
                raise ValueError("A dataset must retain at least one column.")
            info = next(column for column in columns if column["name"] == name)
            token = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO editor_column_snapshots (token, dataset_id, column_name, column_type) VALUES (?, ?, ?, ?)",
                (token, dataset_id, name, info["type"]),
            )
            connection.execute(
                f"INSERT INTO editor_column_snapshot_values (token, row_id, value_json) "
                f"SELECT ?, {rowid}, json_quote({analytics._quote(name)}) FROM {table}",
                (token,),
            )
            connection.execute(f"ALTER TABLE {table} DROP COLUMN {analytics._quote(name)}")
            inverse.append({"type": "restore_column", "token": token})
            normalized.append({"type": "delete_column", "name": name})

        elif kind == "restore_column":
            token = operation.get("token")
            snapshot = connection.execute(
                "SELECT * FROM editor_column_snapshots WHERE token = ? AND dataset_id = ?",
                (token, dataset_id),
            ).fetchone()
            if snapshot is None:
                raise ValueError("The deleted column snapshot is no longer available.")
            if snapshot["column_name"] in names:
                raise ValueError(f"Column '{snapshot['column_name']}' already exists.")
            if len(columns) >= MAX_COLUMNS:
                raise ValueError(f"A dataset may contain at most {MAX_COLUMNS} columns.")
            connection.execute(
                f"ALTER TABLE {table} ADD COLUMN {analytics._quote(snapshot['column_name'])} {snapshot['column_type']}"
            )
            values = connection.execute(
                "SELECT row_id, value_json FROM editor_column_snapshot_values WHERE token = ?",
                (token,),
            ).fetchall()
            for item in values:
                connection.execute(
                    f"UPDATE {table} SET {analytics._quote(snapshot['column_name'])} = json_extract(?, '$') WHERE {rowid} = ?",
                    (item["value_json"], item["row_id"]),
                )
            inverse.append({"type": "delete_column", "name": snapshot["column_name"]})
            normalized.append({"type": "restore_column", "token": token})

        elif kind == "rename_column":
            old_name = operation.get("old_name")
            raw_name = operation.get("name")
            if old_name not in names:
                raise ValueError(f"Column '{old_name}' does not exist in this dataset.")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Column name must not be empty.")
            name = _renamed_column_name(raw_name)
            if any(existing.casefold() == name.casefold() and existing != old_name for existing in names):
                raise ValueError(f"Column '{name}' already exists.")
            if old_name != name:
                connection.execute(
                    f"ALTER TABLE {table} RENAME COLUMN {analytics._quote(old_name)} TO {analytics._quote(name)}"
                )
            inverse.append({"type": "rename_column", "old_name": name, "name": old_name})
            normalized.append({"type": "rename_column", "old_name": old_name, "name": name})

        elif kind == "convert_column":
            name = operation.get("name")
            target_type = str(operation.get("column_type", "")).upper()
            if name not in names:
                raise ValueError(f"Column '{name}' does not exist in this dataset.")
            if target_type not in SQL_TYPES:
                raise ValueError("Column types must be TEXT, INTEGER, REAL, BOOLEAN, or DATE.")
            old_type = next(column["type"].upper() for column in columns if column["name"] == name)
            if old_type != target_type:
                original_values = connection.execute(
                    f"SELECT {rowid}, {analytics._quote(name)} FROM {table} ORDER BY {rowid}"
                )
                while True:
                    batch = original_values.fetchmany(TRANSFORM_BATCH_SIZE)
                    if not batch:
                        break
                    converted = [
                        (_convert_value(row[1], target_type, name), row[0])
                        for row in batch
                    ]
                    connection.executemany(
                        f"UPDATE {table} SET {analytics._quote(name)} = ? WHERE {rowid} = ?",
                        converted,
                    )
                temp_table_name = f"{analytics._table_name(dataset_id)}_type_{uuid.uuid4().hex}"
                temp_table = analytics._quote(temp_table_name)
                definitions = ", ".join(
                    f"{analytics._quote(column['name'])} "
                    f"{target_type if column['name'] == name else (column['type'] or 'TEXT')}"
                    for column in columns
                )
                connection.execute(f"CREATE TABLE {temp_table} ({definitions})")
                names_sql = ", ".join(analytics._quote(column["name"]) for column in columns)
                connection.execute(
                    f"INSERT INTO {temp_table} ({rowid}, {names_sql}) "
                    f"SELECT {rowid}, {names_sql} FROM {table} ORDER BY {rowid}"
                )
                connection.execute(f"DROP TABLE {table}")
                connection.execute(
                    f"ALTER TABLE {temp_table} RENAME TO {analytics._quote(analytics._table_name(dataset_id))}"
                )
                table = analytics._quote(analytics._table_name(dataset_id))
                inverse.append({"type": "convert_column", "name": name, "column_type": old_type})
            normalized.append({"type": "convert_column", "name": name, "column_type": target_type})

        else:
            raise ValueError(f"Unsupported editor operation: {kind}.")

    row_count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    column_count = len(_column_info(connection, dataset_id))
    connection.execute(
        "UPDATE datasets SET row_count = ?, column_count = ? WHERE id = ?",
        (row_count, column_count, dataset_id),
    )
    return {
        "row_id_map": row_id_map,
        "inverse_operations": list(reversed(inverse)),
        "operations": normalized,
        "dataset": dict(analytics._dataset(connection, dataset_id)) | {"status": "ready"},
    }


def _save_transformation_history(
    connection: sqlite3.Connection,
    dataset_id: str,
    transformation_history: list[dict[str, Any]] | None,
) -> None:
    if transformation_history is not None and len(transformation_history) > 100:
        raise ValueError("At most 100 transformation history entries can be saved at once.")
    for item in transformation_history or []:
        if not isinstance(item, dict):
            raise ValueError("Transformation history entries must be objects.")
        operation = str(item.get("operation", "")).strip()[:300]
        columns = item.get("columns", [])
        affected_cells = item.get("affected_cells", 0)
        affected_rows = item.get("affected_rows", 0)
        if (
            not operation or not isinstance(columns, list) or len(columns) > MAX_COLUMNS
            or isinstance(affected_cells, bool) or not isinstance(affected_cells, int) or affected_cells < 0
            or isinstance(affected_rows, bool) or not isinstance(affected_rows, int) or affected_rows < 0
        ):
            raise ValueError("Transformation history entry is invalid.")
        connection.execute(
            """INSERT INTO editor_transformation_history
               (dataset_id, operation, columns_json, affected_cells, affected_rows, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                dataset_id, operation,
                json.dumps([str(column)[:200] for column in columns]),
                affected_cells,
                affected_rows,
                datetime.now(timezone.utc).isoformat(),
            )
        )


def apply_edits(
    dataset_id: str,
    operations: list[dict[str, Any]],
    transformation_history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_OPERATIONS:
        raise ValueError(f"Submit between 1 and {MAX_OPERATIONS} edit operations.")
    with analytics.connect() as connection:
        result = _apply_batch(connection, dataset_id, operations)
        _save_transformation_history(connection, dataset_id, transformation_history)
        connection.commit()
        return result


def get_transformation_history(dataset_id: str) -> list[dict[str, Any]]:
    with analytics.connect_readonly() as connection:
        analytics._dataset(connection, dataset_id)
        rows = connection.execute(
            """SELECT operation, columns_json, affected_cells, affected_rows, created_at
               FROM editor_transformation_history WHERE dataset_id = ? ORDER BY id DESC LIMIT 200""",
            (dataset_id,),
        ).fetchall()
        return [{
            "operation": row["operation"],
            "columns": json.loads(row["columns_json"]),
            "affected_cells": row["affected_cells"],
            "affected_rows": row["affected_rows"],
            "created_at": row["created_at"],
            "applied": True,
        } for row in rows]


def save_as(
    dataset_id: str,
    name: str,
    operations: list[dict[str, Any]] | None = None,
    transformation_history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    with analytics.connect() as connection:
        analytics._dataset(connection, dataset_id)
        source_id = _source_for(connection, dataset_id)
        staged_id = dataset_id
        if operations:
            staging = _clone_dataset(
                connection,
                dataset_id,
                f"editor-save-staging-{uuid.uuid4().hex}.csv",
                "working_copy",
            )
            staged_id = staging["id"]
            _apply_batch(connection, staged_id, operations)
        saved = _clone_dataset(
            connection,
            staged_id,
            _safe_name(name),
            "saved_copy",
        ) | {"original_dataset_id": source_id}
        _save_transformation_history(connection, saved["id"], transformation_history)
        if staged_id != dataset_id:
            connection.execute("DROP TABLE " + analytics._quote(analytics._table_name(staged_id)))
            connection.execute("DELETE FROM dataset_lineage WHERE dataset_id = ?", (staged_id,))
            connection.execute("DELETE FROM datasets WHERE id = ?", (staged_id,))
        return saved


def restore_original(dataset_id: str) -> dict[str, Any]:
    with analytics.connect() as connection:
        mapping = connection.execute(
            "SELECT source_dataset_id FROM dataset_working_copies WHERE working_dataset_id = ?",
            (dataset_id,),
        ).fetchone()
        if mapping is None:
            raise ValueError("Restore Original is available only for an editor working copy.")
        source_id = mapping["source_dataset_id"]
        source_columns = _column_info(connection, source_id)
        if not source_columns:
            raise ValueError("The original dataset has no columns to restore.")
        working_table = analytics._quote(analytics._table_name(dataset_id))
        source_table = analytics._quote(analytics._table_name(source_id))
        current_columns = _column_info(connection, dataset_id)
        _rowid_name(source_columns)
        source_rowid = _rowid_name(source_columns)
        working_rowid = _rowid_name(current_columns)
        connection.execute(f"DROP TABLE {working_table}")
        definitions = ", ".join(
            f"{analytics._quote(column['name'])} {column['type'] or 'TEXT'}"
            for column in source_columns
        )
        connection.execute(f"CREATE TABLE {working_table} ({definitions})")
        names = ", ".join(analytics._quote(column["name"]) for column in source_columns)
        connection.execute(
            f"INSERT INTO {working_table} ({working_rowid}, {names}) "
            f"SELECT {source_rowid}, {names} FROM {source_table} ORDER BY {source_rowid}"
        )
        row_count = connection.execute(f"SELECT COUNT(*) FROM {working_table}").fetchone()[0]
        connection.execute(
            "UPDATE datasets SET row_count = ?, column_count = ? WHERE id = ?",
            (row_count, len(source_columns), dataset_id),
        )
        return dict(analytics._dataset(connection, dataset_id)) | {"status": "ready"}


def export_csv(dataset_id: str, operations: list[dict[str, Any]] | None = None) -> tuple[str, str]:
    connection = analytics.connect()
    try:
        dataset = analytics._dataset(connection, dataset_id)
        if operations:
            _apply_batch(connection, dataset_id, operations)
        table = analytics._quote(analytics._table_name(dataset_id))
        columns = _column_info(connection, dataset_id)
        rows = connection.execute(f"SELECT * FROM {table} ORDER BY {_rowid_name(columns)}").fetchall()
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow([column["name"] for column in columns])
        writer.writerows([[row[column["name"]] for column in columns] for row in rows])
        connection.rollback()
        filename = re.sub(r"[^A-Za-z0-9._-]+", "-", dataset["name"]).strip("-") or "dataset.csv"
        if not filename.lower().endswith(".csv"):
            filename += ".csv"
        return output.getvalue(), filename
    finally:
        connection.close()
