from __future__ import annotations

import json
import math
import re
import statistics
import uuid
from datetime import datetime, timezone
from typing import Any

from backend import analytics

CHART_TYPES = {
    "bar", "horizontal_bar", "grouped_bar", "stacked_bar", "line", "area",
    "pie", "donut", "scatter", "histogram", "heatmap", "box_plot",
    "table", "kpi", "gauge", "correlation",
}
AGGREGATIONS = {"count", "distinct_count", "sum", "avg", "min", "max", "median"}
MAX_GROUPS = 100
MAX_SCATTER_POINTS = 500
MAX_BOXPLOT_VALUES = 50_000
FILTER_OPERATORS = {"eq", "ne", "contains", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"}


def _kind(name: str, sql_type: str, unique: int, row_count: int) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if normalized in {"date", "timestamp", "created_at", "updated_at"} or normalized.endswith(("_date", "_time", "_at")):
        return "date"
    if normalized == "id" or normalized.endswith(("_id", "_key", "_uuid")):
        return "identifier"
    if sql_type in {"INTEGER", "REAL"}:
        if unique <= 2:
            return "boolean"
        return "numeric"
    return "categorical"


def dataset_capabilities(dataset_id: str) -> dict[str, Any]:
    detail = analytics.inspect_dataset(dataset_id)
    profile = analytics.profile_data(dataset_id)
    by_name = {column["name"]: column for column in profile["columns"]}
    boolean_values = {"0", "1", "true", "false", "yes", "no", "y", "n"}
    with analytics.connect_readonly() as connection:
        table = analytics._quote(analytics._table_name(dataset_id))
        raw_columns = analytics._columns(connection, dataset_id)
        actual_kinds: dict[str, str] = {}
        for column in raw_columns:
            name = analytics._quote(column["name"])
            if column["type"] == "TEXT":
                date_valid = connection.execute(
                    f"SELECT COUNT(*), SUM(CASE WHEN date({name}) IS NOT NULL THEN 1 ELSE 0 END) "
                    f"FROM {table} WHERE {name} IS NOT NULL AND TRIM(CAST({name} AS TEXT)) != ''"
                ).fetchone()
                if date_valid[0] and date_valid[1] / date_valid[0] >= 0.9:
                    actual_kinds[column["name"]] = "date"
                    continue
            if column["type"] == "TEXT" and by_name[column["name"]]["unique"] == 2:
                values = {
                    str(row[0]).strip().lower()
                    for row in connection.execute(
                        f"SELECT DISTINCT CAST({name} AS TEXT) FROM {table} "
                        f"WHERE {name} IS NOT NULL LIMIT 3"
                    )
                }
                if values and values <= boolean_values:
                    actual_kinds[column["name"]] = "boolean"
    columns = []
    for column in detail["columns"]:
        stats = by_name[column["name"]]
        kind = actual_kinds.get(
            column["name"],
            _kind(column["name"], column["type"], stats["unique"], detail["shape"]["rows"]),
        )
        columns.append({
            **column,
            "kind": kind,
            "unique": stats["unique"],
            "missing": stats["missing"],
            "missing_percent": stats["missing_percent"],
            "minimum": stats["statistics"]["min"],
            "maximum": stats["statistics"]["max"],
        })
    measure_fields = [column for column in columns if column["kind"] == "numeric"]
    dimensions = [column for column in columns if column["kind"] in {"categorical", "boolean"}]
    dates = [column for column in columns if column["kind"] == "date"]
    return {
        "dataset_id": dataset_id,
        "dataset": detail["dataset"],
        "shape": detail["shape"],
        "columns": columns,
        "roles": {
            "date_fields": [column["name"] for column in dates],
            "measures": [column["name"] for column in measure_fields],
            "dimensions": [column["name"] for column in dimensions],
            "identifiers": [column["name"] for column in columns if column["kind"] == "identifier"],
        },
        "business_metrics": {
            "revenue": any(name in {column["name"] for column in measure_fields} for name in ("revenue", "sales", "amount", "net_revenue", "total")),
            "customer_count": any(column["name"] in {"customer", "customer_id", "account_id", "client_id"} for column in columns),
            "orders": any(column["name"] in {"order_id", "transaction_id", "invoice_id"} for column in columns),
        },
    }


def _column_map(columns: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {column["name"]: column for column in columns}


def validate_config(config: dict[str, Any], capabilities: dict[str, Any]) -> dict[str, Any]:
    chart_type = config.get("type", "bar")
    aggregation = config.get("aggregation", "count")
    if chart_type not in CHART_TYPES:
        raise ValueError(f"Unsupported visualization type: {chart_type}.")
    if aggregation not in AGGREGATIONS:
        raise ValueError(f"Unsupported aggregation: {aggregation}.")
    columns = _column_map(capabilities["columns"])

    def field(key: str, allowed: set[str] | None = None) -> str | None:
        value = config.get(key)
        if value is None or value == "":
            return None
        if value not in columns:
            raise ValueError(f"Field '{value}' does not exist in the selected dataset.")
        if allowed and columns[value]["kind"] not in allowed:
            raise ValueError(f"Field '{value}' is not compatible with {key.replace('_', ' ')}.")
        return value

    x_field = field("x_field")
    y_field = field("y_field")
    legend_field = field("legend_field", {"categorical", "boolean"})
    if chart_type in {"bar", "horizontal_bar", "grouped_bar", "stacked_bar", "line", "area", "pie", "donut", "heatmap", "box_plot"} and not x_field:
        raise ValueError("Select a category or date field for the chart axis.")
    if chart_type in {"scatter", "histogram", "box_plot"} and not y_field and chart_type != "histogram":
        raise ValueError("Select a numeric measure for this visualization.")
    if chart_type in {"scatter"}:
        field("x_field", {"numeric"})
        field("y_field", {"numeric"})
    if chart_type == "histogram":
        histogram_field = y_field or x_field
        if histogram_field:
            field("y_field" if y_field else "x_field", {"numeric"})
    numeric_aggregations = {"sum", "avg", "min", "max", "median"}
    if aggregation in numeric_aggregations and y_field and columns[y_field]["kind"] not in {"numeric", "boolean"}:
        raise ValueError(f"{aggregation.title()} requires a numeric measure.")
    if chart_type == "correlation":
        chosen = config.get("fields") or [column["name"] for column in capabilities["columns"] if column["kind"] == "numeric"]
        if not isinstance(chosen, list) or not 2 <= len(chosen) <= 12:
            raise ValueError("A correlation matrix requires 2–12 numeric fields.")
        for name in chosen:
            if name not in columns or columns[name]["kind"] != "numeric":
                raise ValueError(f"Correlation field '{name}' must be numeric.")
    filters = config.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 20:
        raise ValueError("Use no more than 20 visualization filters.")
    normalized_filters = []
    for item in filters:
        if not isinstance(item, dict):
            raise ValueError("Each filter must be an object.")
        name = item.get("field")
        operator = item.get("operator", "eq")
        if name not in columns:
            raise ValueError(f"Filter field '{name}' does not exist in the selected dataset.")
        if operator not in FILTER_OPERATORS:
            raise ValueError(f"Unsupported filter operator: {operator}.")
        value = item.get("value")
        if operator in {"gt", "gte", "lt", "lte"}:
            kind = columns[name]["kind"]
            if kind == "numeric":
                try:
                    value = float(value)
                except (TypeError, ValueError) as error:
                    raise ValueError(f"Filter operator '{operator}' requires a numeric value.") from error
                if not math.isfinite(value):
                    raise ValueError(f"Filter operator '{operator}' requires a finite numeric value.")
            elif kind == "date":
                if not isinstance(value, str):
                    raise ValueError(f"Filter operator '{operator}' requires an ISO date value.")
                try:
                    datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError as error:
                    raise ValueError(f"Filter operator '{operator}' requires an ISO date value.") from error
            else:
                raise ValueError(f"Filter operator '{operator}' requires a numeric or date field.")
        if operator == "contains" and columns[name]["kind"] not in {"categorical", "identifier"}:
            raise ValueError("Contains filters require a text-like field.")
        if operator == "in" and (not isinstance(value, list) or len(value) > 100):
            raise ValueError("An 'in' filter requires a list of up to 100 values.")
        normalized_filters.append({"field": name, "operator": operator, "value": value})
    top_n = config.get("top_n")
    if top_n is not None and (not isinstance(top_n, int) or isinstance(top_n, bool) or not 1 <= top_n <= MAX_GROUPS):
        raise ValueError(f"Top N must be between 1 and {MAX_GROUPS}.")
    if config.get("bin_size") is not None and (
        not isinstance(config["bin_size"], (int, float))
        or isinstance(config["bin_size"], bool)
        or config["bin_size"] <= 0
    ):
        raise ValueError("Bin size must be a positive number.")
    return {
        **config,
        "type": chart_type,
        "aggregation": aggregation,
        "x_field": x_field,
        "y_field": y_field,
        "legend_field": legend_field,
        "filters": normalized_filters,
        "top_n": top_n,
    }


def _where_clause(
    filters: list[dict[str, Any]],
    columns: list[dict[str, Any]] | None = None,
) -> tuple[str, list[Any]]:
    clauses = []
    params: list[Any] = []
    operators = {"eq": "=", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
    column_map = _column_map(columns or [])
    for item in filters:
        name = analytics._quote(item["field"])
        operator = item["operator"]
        value = item.get("value")
        if operator in {"is_null", "not_null"}:
            clauses.append(f"{name} IS {'NOT ' if operator == 'not_null' else ''}NULL")
        elif operator == "in":
            if not value:
                clauses.append("0")
            else:
                clauses.append(f"{name} IN ({', '.join('?' for _ in value)})")
                params.extend(value)
        elif operator == "contains":
            escaped = str(value or "").replace("~", "~~").replace("%", "~%").replace("_", "~_")
            clauses.append(f"CAST({name} AS TEXT) LIKE ? ESCAPE '~'")
            params.append(f"%{escaped}%")
        else:
            is_date = operator in operators and column_map.get(item["field"], {}).get("kind") == "date"
            operand = f"date({name})" if is_date else name
            placeholder = "date(?)" if is_date else "?"
            clauses.append(f"{operand} {operators[operator]} {placeholder}")
            params.append(value)
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), params


class _Median:
    def __init__(self) -> None:
        self.values: list[float] = []

    def step(self, value: Any) -> None:
        if value is not None:
            try:
                number = float(value)
                if math.isfinite(number):
                    self.values.append(number)
            except (TypeError, ValueError):
                return

    def finalize(self) -> float | None:
        return statistics.median(self.values) if self.values else None


class _Percentile:
    def __init__(self) -> None:
        self.values: list[float] = []
        self.percentile = 0.5

    def step(self, value: Any, percentile: Any) -> None:
        if value is not None:
            try:
                number = float(value)
                if math.isfinite(number):
                    self.values.append(number)
                    self.percentile = float(percentile)
            except (TypeError, ValueError):
                return

    def finalize(self) -> float | None:
        if not self.values:
            return None
        self.values.sort()
        index = (len(self.values) - 1) * self.percentile
        low = math.floor(index)
        high = math.ceil(index)
        return self.values[low] + (self.values[high] - self.values[low]) * (index - low)


def aggregate_dataset(dataset_id: str, raw_config: dict[str, Any]) -> dict[str, Any]:
    capabilities = dataset_capabilities(dataset_id)
    config = validate_config(raw_config, capabilities)
    connection = analytics.connect_readonly()
    try:
        connection.create_aggregate("MEDIAN", 1, _Median)
        connection.create_aggregate("PERCENTILE_CONT", 2, _Percentile)
        table = analytics._quote(analytics._table_name(dataset_id))
        where, params = _where_clause(config["filters"], capabilities["columns"])
        chart_type = config["type"]
        if chart_type == "correlation":
            return _correlation(connection, table, config, where, params, capabilities)
        if chart_type == "scatter":
            return _scatter(connection, table, config, where, params)
        if chart_type == "histogram":
            return _histogram(connection, table, config, where, params)
        if chart_type == "box_plot":
            return _box_plot(connection, table, config, where, params)
        if chart_type in {"kpi", "gauge"}:
            if config.get("y_field"):
                config["_y_kind"] = _column_map(capabilities["columns"])[config["y_field"]]["kind"]
            kpi_result = _kpi(connection, table, config, where, params)
            kpi_result["config"] = {key: value for key, value in config.items() if not key.startswith("_")}
            return kpi_result
        if chart_type == "table":
            return _data_table(connection, table, config, where, params, capabilities)
        return _grouped(connection, table, config, where, params, capabilities)
    finally:
        connection.close()


def _aggregate_expression(config: dict[str, Any]) -> str:
    aggregation = config["aggregation"]
    y_field = config.get("y_field")
    if aggregation == "count":
        return "COUNT(*)" if not y_field else f"COUNT({analytics._quote(y_field)})"
    if aggregation == "distinct_count":
        if not y_field:
            raise ValueError("Choose a field for distinct count.")
        return f"COUNT(DISTINCT {analytics._quote(y_field)})"
    if not y_field:
        raise ValueError(f"Choose a numeric measure for {aggregation}.")
    name = analytics._quote(y_field)
    if aggregation == "median":
        if config.get("_y_kind") == "boolean":
            boolean = analytics._quote(y_field)
            return f"MEDIAN(CASE WHEN lower(trim(CAST({boolean} AS TEXT))) IN ('1','true','yes','y') THEN 1.0 WHEN lower(trim(CAST({boolean} AS TEXT))) IN ('0','false','no','n') THEN 0.0 END)"
        return f"MEDIAN(CASE WHEN typeof({name}) IN ('integer', 'real') THEN {name} END)"
    if config.get("_y_kind") == "boolean":
        numeric = (
            f"CASE WHEN lower(trim(CAST({name} AS TEXT))) IN ('1','true','yes','y') THEN 1.0 "
            f"WHEN lower(trim(CAST({name} AS TEXT))) IN ('0','false','no','n') THEN 0.0 END"
        )
        return f"{aggregation.upper()}({numeric})"
    return f"{aggregation.upper()}(CASE WHEN typeof({name}) IN ('integer', 'real') THEN {name} END)"


def _grouped(
    connection: Any,
    table: str,
    config: dict[str, Any],
    where: str,
    params: list[Any],
    capabilities: dict[str, Any],
) -> dict[str, Any]:
    x_field = config.get("x_field")
    legend = config.get("legend_field")
    measure_config = dict(config)
    if config.get("y_field"):
        measure_config["_y_kind"] = _column_map(capabilities["columns"])[config["y_field"]]["kind"]
    expression = _aggregate_expression(measure_config)
    bin_size = config.get("bin_size")
    if x_field and bin_size and _column_map(capabilities["columns"])[x_field]["kind"] == "numeric":
        raw_x = analytics._quote(x_field)
        x_name = (
            f"CAST(CAST({raw_x} / {float(bin_size)} AS INTEGER) * {float(bin_size)} AS TEXT) "
            f"|| '–' || CAST((CAST({raw_x} / {float(bin_size)} AS INTEGER) + 1) * {float(bin_size)} AS TEXT)"
        )
    else:
        x_name = analytics._quote(x_field) if x_field else "'Records'"
    dimensions = [x_name]
    select = [f"{x_name} AS category"]
    if legend and legend != x_field:
        dimensions.append(analytics._quote(legend))
        select.append(f"{analytics._quote(legend)} AS series")
    select.append(f"{expression} AS value")
    group_sql = f" GROUP BY {', '.join(dimensions)}" if x_field else ""
    sort_order = "DESC" if config.get("sort", "desc") == "desc" else "ASC"
    sort_sql = (
        " ORDER BY category ASC"
        if config.get("type") in {"line", "area"} and _column_map(capabilities["columns"]).get(x_field, {}).get("kind") == "date"
        else f" ORDER BY value {sort_order}, category ASC"
    )
    limit_sql = f" LIMIT {config['top_n']}" if config.get("top_n") and not legend else f" LIMIT {MAX_GROUPS * 20}"
    rows = connection.execute(
        f"SELECT {', '.join(select)} FROM {table}{where}{group_sql}{sort_sql}{limit_sql}",
        params,
    ).fetchall()
    output = []
    for row in rows:
        record = dict(row)
        if isinstance(record.get("value"), float):
            record["value"] = round(record["value"], 6)
        output.append(record)
    return {
        "dataset_id": capabilities["dataset_id"],
        "config": config,
        "columns": ["category"] + (["series"] if legend and legend != x_field else []) + ["value"],
        "rows": output,
        "row_count": len(output),
        "metadata": {
            "aggregated": True,
            "aggregation": config["aggregation"],
            "field_kind": _column_map(capabilities["columns"]).get(x_field, {}).get("kind") if x_field else "all records",
        },
    }


def _scatter(connection: Any, table: str, config: dict[str, Any], where: str, params: list[Any]) -> dict[str, Any]:
    x, y = analytics._quote(config["x_field"]), analytics._quote(config["y_field"])
    legend = config.get("legend_field")
    selection = [f"{x} AS x", f"{y} AS y"]
    if legend:
        selection.append(f"{analytics._quote(legend)} AS series")
    rows = connection.execute(
        f"SELECT {', '.join(selection)} FROM {table}{where}{' AND ' if where else ' WHERE '}"
        f"{x} IS NOT NULL AND {y} IS NOT NULL AND typeof({x}) IN ('integer','real') "
        f"AND typeof({y}) IN ('integer','real') LIMIT {MAX_SCATTER_POINTS}",
        params,
    ).fetchall()
    return {
        "config": config, "columns": ["x", "y"] + (["series"] if legend else []),
        "rows": [dict(row) for row in rows], "row_count": len(rows),
        "metadata": {"aggregated": False, "sample_limit": MAX_SCATTER_POINTS},
    }


def _histogram(connection: Any, table: str, config: dict[str, Any], where: str, params: list[Any]) -> dict[str, Any]:
    field = config.get("y_field") or config.get("x_field")
    name = analytics._quote(field)
    bin_count = min(max(int(config.get("bins", 20)), 2), 60)
    bounds = connection.execute(
        f"SELECT MIN({name}), MAX({name}), COUNT(*) FROM {table}{where}"
        f"{' AND ' if where else ' WHERE '}typeof({name}) IN ('integer','real')",
        params,
    ).fetchone()
    minimum, maximum, count = bounds
    if count == 0:
        rows = []
    elif minimum == maximum:
        rows = [{"category": str(minimum), "value": int(count), "lower": minimum, "upper": maximum}]
    else:
        width = (maximum - minimum) / bin_count
        values = connection.execute(
            f"SELECT MIN(MAX(CAST(({name} - ?) / ? AS INTEGER), 0), ?) AS bin, COUNT(*) AS value "
            f"FROM {table}{where}{' AND ' if where else ' WHERE '}typeof({name}) IN ('integer','real') "
            "GROUP BY bin ORDER BY bin",
            [minimum, width, bin_count - 1, *params],
        ).fetchall()
        rows = [{
            "category": f"{minimum + item['bin'] * width:.3g}–{minimum + (item['bin'] + 1) * width:.3g}",
            "value": item["value"],
            "lower": minimum + item["bin"] * width,
            "upper": minimum + (item["bin"] + 1) * width,
        } for item in values]
    return {"config": config, "columns": ["category", "value"], "rows": rows, "row_count": len(rows), "metadata": {"aggregated": True, "source_count": count, "bins": bin_count}}


def _box_plot(connection: Any, table: str, config: dict[str, Any], where: str, params: list[Any]) -> dict[str, Any]:
    field = analytics._quote(config["y_field"])
    x_field = config.get("x_field")
    x_sql = analytics._quote(x_field) if x_field else "'All records'"
    if x_field:
        group_count = connection.execute(f"SELECT COUNT(DISTINCT {x_sql}) FROM {table}{where}", params).fetchone()[0]
        if group_count > 100:
            raise ValueError("Box plots support at most 100 categories; apply a filter or select fewer categories.")
    values = connection.execute(
        f"SELECT {x_sql} AS category, {field} AS value FROM {table}{where}"
        f"{' AND ' if where else ' WHERE '}typeof({field}) IN ('integer','real')"
        f" ORDER BY category LIMIT {MAX_BOXPLOT_VALUES}"
    ).fetchall()
    grouped: dict[str, list[float]] = {}
    for item in values:
        grouped.setdefault(str(item["category"]), []).append(float(item["value"]))
    rows = []
    for category, samples in grouped.items():
        samples.sort()
        rows.append({
            "category": category,
            "min": samples[0],
            "q1": _quantile(samples, 0.25),
            "median": _quantile(samples, 0.5),
            "q3": _quantile(samples, 0.75),
            "max": samples[-1],
        })
    return {"config": config, "columns": ["category", "min", "q1", "median", "q3", "max"], "rows": rows, "row_count": len(rows), "metadata": {"aggregated": True, "sampled": len(values) >= MAX_BOXPLOT_VALUES}}


def _quantile(values: list[float], percentile: float) -> float:
    position = (len(values) - 1) * percentile
    low, high = math.floor(position), math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)


def _kpi(connection: Any, table: str, config: dict[str, Any], where: str, params: list[Any]) -> dict[str, Any]:
    expression = _aggregate_expression(config)
    value = connection.execute(f"SELECT {expression} FROM {table}{where}", params).fetchone()[0]
    return {"config": config, "columns": ["value"], "rows": [{"value": value}], "row_count": 1, "metadata": {"aggregated": True}}


def _data_table(connection: Any, table: str, config: dict[str, Any], where: str, params: list[Any], capabilities: dict[str, Any]) -> dict[str, Any]:
    columns = config.get("fields") or [column["name"] for column in capabilities["columns"]]
    if not columns or any(column not in _column_map(capabilities["columns"]) for column in columns):
        raise ValueError("Choose valid dataset columns for the table.")
    selection = ", ".join(analytics._quote(column) for column in columns)
    rows = connection.execute(f"SELECT {selection} FROM {table}{where} LIMIT 200", params).fetchall()
    return {"config": config, "columns": columns, "rows": [dict(row) for row in rows], "row_count": len(rows), "metadata": {"aggregated": False, "limit": 200}}


def _correlation(
    connection: Any,
    table: str,
    config: dict[str, Any],
    where: str,
    params: list[Any],
    capabilities: dict[str, Any],
) -> dict[str, Any]:
    numeric = [column["name"] for column in capabilities["columns"] if column["kind"] == "numeric"]
    fields = config.get("fields") or numeric
    rows = []
    for left in fields:
        result = []
        for right in fields:
            a, b = analytics._quote(left), analytics._quote(right)
            numeric_predicate = f"typeof({a}) IN ('integer','real') AND typeof({b}) IN ('integer','real')"
            values = connection.execute(
                f"SELECT COUNT(CASE WHEN {numeric_predicate} THEN 1 END), "
                f"SUM(CASE WHEN {numeric_predicate} THEN {a} END), "
                f"SUM(CASE WHEN {numeric_predicate} THEN {b} END), "
                f"SUM(CASE WHEN {numeric_predicate} THEN {a} * {a} END), "
                f"SUM(CASE WHEN {numeric_predicate} THEN {b} * {b} END), "
                f"SUM(CASE WHEN {numeric_predicate} THEN {a} * {b} END) "
                f"FROM {table}{where}",
                params,
            ).fetchone()
            coefficient = None
            count, sum_x, sum_y, sum_x2, sum_y2, sum_xy = values
            if count and count >= 2:
                numerator = count * sum_xy - sum_x * sum_y
                denominator_x = count * sum_x2 - sum_x * sum_x
                denominator_y = count * sum_y2 - sum_y * sum_y
                denominator = math.sqrt(max(denominator_x, 0) * max(denominator_y, 0))
                if denominator:
                    coefficient = round(numerator / denominator, 4)
            result.append(coefficient)
        rows.append({"field": left, "values": result})
    return {"config": config, "columns": fields, "rows": rows, "row_count": len(rows), "metadata": {"aggregated": True, "method": "Pearson correlation", "pairwise_missing_values": "excluded"}}


def recommend_visualizations(dataset_id: str) -> dict[str, Any]:
    capabilities = dataset_capabilities(dataset_id)
    columns = capabilities["columns"]
    numbers = [column for column in columns if column["kind"] == "numeric"]
    categories = [column for column in columns if column["kind"] in {"categorical", "boolean"}]
    dates = [column for column in columns if column["kind"] == "date"]
    recommendations = []

    def add(question: str, chart_type: str, config: dict[str, Any], required: list[str], reason: str) -> None:
        recommendations.append({
            "id": str(len(recommendations) + 1),
            "question": question,
            "type": chart_type,
            "config": {"title": question, "type": chart_type, "filters": [], **config},
            "required_fields": required,
            "reason": reason,
        })

    add("How many records are in this dataset?", "kpi", {"aggregation": "count"}, [], "A count KPI summarizes the full dataset without assuming a business metric.")
    for category in categories[:3]:
        add(
            f"How are records distributed by {category['name']}?",
            "bar",
            {"x_field": category["name"], "aggregation": "count", "sort": "desc", "top_n": 15},
            [category["name"]],
            "A categorical field supports frequency counting.",
        )
    if dates and numbers:
        add(
            f"How does {numbers[0]['name']} change over time?",
            "line",
            {"x_field": dates[0]["name"], "y_field": numbers[0]["name"], "aggregation": "sum", "sort": "asc"},
            [dates[0]["name"], numbers[0]["name"]],
            "A date field and numeric measure support a time-series aggregation.",
        )
    for number in numbers[:2]:
        add(
            f"What is the distribution of {number['name']}?",
            "histogram",
            {"x_field": number["name"], "aggregation": "count", "bins": 20},
            [number["name"]],
            "A numeric field supports value-distribution binning.",
        )
    if len(numbers) >= 2:
        add(
            f"How are {numbers[0]['name']} and {numbers[1]['name']} related?",
            "scatter",
            {"x_field": numbers[0]["name"], "y_field": numbers[1]["name"]},
            [numbers[0]["name"], numbers[1]["name"]],
            "Two numeric fields support a scatter plot for visual inspection; association is not causation.",
        )
        add(
            "How do numeric fields correlate?",
            "correlation",
            {"fields": [column["name"] for column in numbers[:12]]},
            [column["name"] for column in numbers[:12]],
            "A Pearson correlation matrix is computed from pairwise complete numeric observations.",
        )
    outcome = next((column for column in columns if column["name"] in {"stroke", "outcome", "churn", "converted"} and column["kind"] == "boolean"), None)
    if outcome and categories:
        add(
            f"What is the {outcome['name']} rate by {categories[0]['name']}?",
            "bar",
            {"x_field": categories[0]["name"], "y_field": outcome["name"], "aggregation": "avg", "sort": "desc"},
            [categories[0]["name"], outcome["name"]],
            "The outcome is binary, so its mean is the positive-case prevalence among non-null records.",
        )
    return {"dataset_id": dataset_id, "recommendations": recommendations}


def paginated_records(
    dataset_id: str,
    offset: int = 0,
    limit: int = 50,
    search: str | None = None,
) -> dict[str, Any]:
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError("Offset must be non-negative and limit must be from 1 to 200.")
    with analytics.connect_readonly() as connection:
        dataset = analytics._dataset(connection, dataset_id)
        columns = analytics._columns(connection, dataset_id)
        table = analytics._quote(analytics._table_name(dataset_id))
        where, params = _where_clause([])
        if search:
            escaped = search.replace("~", "~~").replace("%", "~%").replace("_", "~_")
            where = " WHERE " + " OR ".join(
                f"CAST({analytics._quote(column['name'])} AS TEXT) LIKE ? ESCAPE '~'" for column in columns
            )
            params = [f"%{escaped}%"] * len(columns)
        count = connection.execute(f"SELECT COUNT(*) FROM {table}{where}", params).fetchone()[0]
        rows = connection.execute(
            f"SELECT * FROM {table}{where} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        return {
            "dataset_id": dataset_id,
            "total": count,
            "offset": offset,
            "limit": limit,
            "columns": [column["name"] for column in columns],
            "rows": [dict(row) for row in rows],
        }


def save_report(payload: dict[str, Any], report_id: str | None = None) -> dict[str, Any]:
    title = str(payload.get("title", "")).strip()
    dataset_id = payload.get("dataset_id")
    visualizations = payload.get("visualizations", [])
    if not title or len(title) > 160:
        raise ValueError("Report title must contain 1–160 characters.")
    if not isinstance(visualizations, list) or len(visualizations) > 30:
        raise ValueError("A report may contain up to 30 visualizations.")
    capabilities = dataset_capabilities(dataset_id)
    validated = [validate_config(config, capabilities) for config in visualizations]
    validated_filters = validate_config(
        {"type": "kpi", "aggregation": "count", "filters": payload.get("filters", [])},
        capabilities,
    )["filters"]
    report_id = report_id or str(uuid.uuid4())
    timestamp = datetime.now(timezone.utc).isoformat()
    payload_text = json.dumps({"visualizations": validated, "filters": validated_filters})
    with analytics.connect() as connection:
        existing = connection.execute("SELECT created_at FROM saved_reports WHERE id = ?", (report_id,)).fetchone()
        if report_id and existing is None and payload.get("id"):
            raise ValueError("Saved report not found.")
        created_at = existing["created_at"] if existing else timestamp
        connection.execute(
            "INSERT INTO saved_reports (id, title, dataset_id, payload_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, "
            "dataset_id=excluded.dataset_id, payload_json=excluded.payload_json, updated_at=excluded.updated_at",
            (report_id, title, dataset_id, payload_text, created_at, timestamp),
        )
    return {"id": report_id, "title": title, "dataset_id": dataset_id, "created_at": created_at, "updated_at": timestamp, **json.loads(payload_text)}


def list_reports() -> list[dict[str, Any]]:
    with analytics.connect_readonly() as connection:
        rows = connection.execute(
            "SELECT id, title, dataset_id, created_at, updated_at FROM saved_reports ORDER BY updated_at DESC LIMIT 100"
        )
        return [dict(row) for row in rows]


def get_report(report_id: str) -> dict[str, Any]:
    with analytics.connect_readonly() as connection:
        row = connection.execute(
            "SELECT id, title, dataset_id, payload_json, created_at, updated_at FROM saved_reports WHERE id = ?",
            (report_id,),
        ).fetchone()
    if row is None:
        raise ValueError("Saved report not found.")
    try:
        analytics.inspect_dataset(row["dataset_id"])
        dataset_available = True
    except ValueError:
        dataset_available = False
    return {
        **{key: row[key] for key in ("id", "title", "dataset_id", "created_at", "updated_at")},
        **json.loads(row["payload_json"]),
        "dataset_available": dataset_available,
    }


def delete_report(report_id: str) -> None:
    with analytics.connect() as connection:
        cursor = connection.execute("DELETE FROM saved_reports WHERE id = ?", (report_id,))
        if cursor.rowcount == 0:
            raise ValueError("Saved report not found.")


def analyze_question(dataset_id: str, question: str) -> dict[str, Any]:
    question = question.strip()
    if not question or len(question) > 1000:
        raise ValueError("Question must contain 1–1,000 characters.")
    lowered = question.lower()
    recommendations = recommend_visualizations(dataset_id)["recommendations"]
    capabilities = dataset_capabilities(dataset_id)
    columns = capabilities["columns"]
    aliases = {
        "glucose": ("avg_glucose_level", "glucose", "blood_glucose"),
        "age group": ("age", "age_group"),
        "age": ("age", "age_years"),
        "stroke": ("stroke",),
        "smoking": ("smoking_status", "smoking"),
        "gender": ("gender", "sex"),
        "bmi": ("bmi", "body_mass_index"),
        "hypertension": ("hypertension", "high_blood_pressure"),
        "heart disease": ("heart_disease", "heart_disease_status"),
    }
    field_by_name = {column["name"].lower(): column for column in columns}
    requested: list[dict[str, Any]] = []
    for phrase, names in aliases.items():
        if phrase in lowered:
            requested.extend(field_by_name[name] for name in names if name in field_by_name)
    if not requested:
        tokens = [token for token in re.findall(r"[a-z0-9_]+", lowered) if len(token) > 2]
        requested = [
            column for column in columns
            if any(token in column["name"].lower() or column["name"].lower() in token for token in tokens)
        ]
    unique_requested = []
    for column in requested:
        if column not in unique_requested:
            unique_requested.append(column)

    config: dict[str, Any] | None = None
    if any(token in lowered for token in ("missing value", "missing data", "data quality", "missingness")):
        return {"kind": "quality", "answer": analytics.profile_data(dataset_id), "provider": "rule-based", "reason": "Profile results are calculated from the actual dataset."}
    if any(token in lowered for token in ("recommend", "useful charts", "suggestion")):
        return {"kind": "recommendations", "answer": recommendations, "provider": "rule-based"}

    numeric_requested = [column for column in unique_requested if column["kind"] == "numeric"]
    categorical_requested = [column for column in unique_requested if column["kind"] in {"categorical", "boolean"}]
    type_hint = next((kind for word, kind in (
        ("donut", "donut"), ("doughnut", "donut"), ("pie chart", "pie"),
        ("scatter", "scatter"), ("histogram", "histogram"), ("distribution", "histogram"),
        ("line chart", "line"), ("trend", "line"), ("area chart", "area"),
    ) if word in lowered), None)

    outcome = next((column for column in unique_requested if column["kind"] == "boolean"), None)
    numeric_context = next((column for column in unique_requested if column["kind"] == "numeric"), None)
    group_context = next((column for column in unique_requested if column["kind"] in {"categorical", "boolean"} and column is not outcome), None)
    if (type_hint == "scatter" or any(word in lowered for word in ("relationship", "correlation", "against"))) and len(numeric_requested) >= 2:
        config = {"title": question, "type": "scatter", "x_field": numeric_requested[0]["name"], "y_field": numeric_requested[1]["name"]}
    elif type_hint == "histogram" and numeric_context:
        config = {"title": question, "type": "histogram", "x_field": numeric_context["name"], "aggregation": "count"}
    elif type_hint in {"pie", "donut"}:
        category = group_context or (categorical_requested[0] if categorical_requested else None)
        if category is None:
            category = next((column for column in columns if column["kind"] in {"categorical", "boolean"}), None)
        if category:
            config = {"title": question, "type": type_hint, "x_field": category["name"], "aggregation": "count", "top_n": 15}
    elif outcome and numeric_context and any(word in lowered for word in ("prevalence", "rate", "percentage", "percent", "age group", "by age")):
        config = {
            "title": question, "type": "bar", "x_field": numeric_context["name"],
            "y_field": outcome["name"], "aggregation": "avg", "sort": "desc", "bin_size": 10,
            "format": "percent",
        }
    elif outcome and group_context and any(word in lowered for word in ("prevalence", "rate", "percentage", "percent", "by")):
        config = {
            "title": question, "type": "bar", "x_field": group_context["name"],
            "y_field": outcome["name"], "aggregation": "avg", "sort": "desc", "format": "percent",
        }
    elif numeric_context and outcome and any(word in lowered for word in ("average", "mean", "compare", "comparison")):
        config = {
            "title": question, "type": "bar", "x_field": outcome["name"],
            "y_field": numeric_context["name"], "aggregation": "avg", "sort": "desc",
        }
    elif numeric_context and any(word in lowered for word in ("over time", "trend", "by date")):
        date_column = next((column for column in columns if column["kind"] == "date"), None)
        if date_column:
            config = {"title": question, "type": "line", "x_field": date_column["name"], "y_field": numeric_context["name"], "aggregation": "sum", "sort": "asc"}
    elif categorical_requested:
        config = {"title": question, "type": "bar", "x_field": categorical_requested[0]["name"], "aggregation": "count", "top_n": 15}
    if config is None:
        recommendation = next((item for item in recommendations if all(
            field in {column["name"] for column in columns}
            for field in item["required_fields"]
        )), None)
        if recommendation:
            config = dict(recommendation["config"])
            config["title"] = question
        else:
            return {"kind": "clarification", "answer": "I could not match that question to a supported analysis for this dataset. Which fields should I use?", "provider": "rule-based"}
    config["filters"] = []
    return {"kind": "visualization", "config": validate_config(config, capabilities), "provider": "rule-based"}
