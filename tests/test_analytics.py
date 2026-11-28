from datetime import date, timedelta
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import analytics, api, studio


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / "test.sqlite"
    monkeypatch.setattr(analytics, "DB_PATH", path)
    analytics.initialize()
    return path


def upload(database, filename, content):
    return analytics.ingest_csv(filename, content.encode("utf-8"))


def test_seed_catalog_and_schema_inspection(database):
    datasets = analytics.list_datasets()
    assert datasets
    sample = next(item for item in datasets if item["name"] == "sample_sales.csv")
    inspection = analytics.inspect_dataset(sample["id"])
    assert inspection["shape"]["rows"] == 360
    assert {"order_date", "revenue", "customer_id"} <= inspection["schema"].keys()
    assert len(inspection["sample"]) == 5


def test_ingest_normalizes_duplicate_headers_and_calculates_period_metrics(database):
    today = date.today()
    start = today - timedelta(days=6)
    content = (
        "Order Date,Revenue,Revenue,Customer ID\n"
        f"{today.isoformat()},100,50,C1\n"
        f"{(today - timedelta(days=1)).isoformat()},200,75,C2\n"
        f"{(today - timedelta(days=8)).isoformat()},40,10,C3\n"
    )
    dataset = upload(database, "sales.csv", content)
    inspected = analytics.inspect_dataset(dataset["id"])
    assert [column["name"] for column in inspected["columns"]] == ["order_date", "revenue", "revenue_2", "customer_id"]
    result = analytics.metrics(dataset["id"], 7)
    assert result["metrics"]["revenue"] == 300
    assert result["metrics"]["active_customers"] == 2
    assert result["comparison"]["revenue"]["absolute_change"] == 260
    assert len(result["series"]) == 2
    assert start.isoformat() <= result["period"]["start"]


def test_quality_report_is_reproducible(database):
    dataset = upload(database, "quality.csv", "customer_id,revenue\nA,10\nA,10\nB,\n")
    report = analytics.quality_report(dataset["id"])
    assert report["duplicate_count"] == 1
    assert report["missing_values"] == 1
    assert report["score"] < 100
    assert {issue["type"] for issue in report["issues"]} == {"missing_values", "duplicate_rows"}


def test_readonly_sql_allows_selected_dataset_and_rejects_writes_and_other_tables(database):
    first = upload(database, "first.csv", "name,value\nalpha,10\n")
    second = upload(database, "second.csv", "name,value\nbeta,20\n")
    table = f"dataset_{first['id'].replace('-', '')}"
    result = analytics.run_readonly_sql(first["id"], f"SELECT name, value FROM {table}")
    assert result["rows"] == [{"name": "alpha", "value": 10}]
    with pytest.raises(ValueError, match="read-only"):
        analytics.run_readonly_sql(first["id"], f"DELETE FROM {table}")
    other_table = f"dataset_{second['id'].replace('-', '')}"
    with pytest.raises(ValueError, match="selected dataset"):
        analytics.run_readonly_sql(first["id"], f"SELECT * FROM {other_table}")
    with pytest.raises(ValueError, match="SQL error"):
        analytics.run_readonly_sql(first["id"], f"SELECT * FROM {table}; SELECT * FROM {table}")


@pytest.mark.parametrize(
    ("filename", "content", "message"),
    [
        ("data.xlsx", b"not csv", "Only CSV"),
        ("data.csv", b"\xff\xfe", "UTF-8"),
        ("data.csv", b"header\none,two\n", "same number"),
        ("data.csv", b"", "header row"),
    ],
)
def test_upload_rejects_unsupported_or_malformed_files(database, filename, content, message):
    with pytest.raises(ValueError, match=message):
        analytics.ingest_csv(filename, content)


def test_custom_period_and_bound_validation(database):
    dataset = upload(database, "dated.csv", f"date,revenue\n{date.today().isoformat()},5\n")
    result = analytics.metrics(dataset["id"], start_date=date.today().isoformat(), end_date=date.today().isoformat())
    assert result["metrics"]["revenue"] == 5
    with pytest.raises(ValueError, match="End date"):
        analytics.metrics(dataset["id"], start_date="2025-01-02", end_date="2025-01-01")


def test_data_access_validates_dataset_identifier(database):
    with pytest.raises(ValueError, match="Dataset not found"):
        analytics.inspect_dataset("2b0d1751-c6b1-4e8a-9b45-0f7bb44c8221")


def test_mcp_tools_are_registered():
    from backend.mcp_server import mcp

    registered = {tool.name for tool in mcp._tool_manager.list_tools()}
    assert {
        "list_datasets", "inspect_dataset", "profile_data", "run_readonly_sql",
        "detect_anomalies", "compare_periods", "get_business_metrics",
        "search_dataset", "get_data_quality_report",
        "recommend_visualizations", "aggregate_dataset",
    } <= registered


def test_api_health_upload_and_sql_history(database):
    with TestClient(api.app) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        upload_response = client.post(
            "/api/datasets/upload",
            files={"file": ("api.csv", "name,value\nalpha,10\n", "text/csv")},
        )
        assert upload_response.status_code == 200
        dataset = upload_response.json()
        table = f"dataset_{dataset['id'].replace('-', '')}"
        result = client.post("/api/sql/execute", json={
            "dataset_id": dataset["id"], "query": f"SELECT * FROM {table}",
        })
        assert result.status_code == 200
        assert result.json()["rows"] == [{"name": "alpha", "value": 10}]
        assert client.get("/api/sql/history").json()[0]["query"].startswith("SELECT")
        assert client.get(f"/api/datasets/{dataset['id']}/profile").status_code == 200
        assert client.get(f"/api/datasets/{dataset['id']}/quality").status_code == 200
        metric_export = client.get(f"/api/exports/metrics?dataset_id={dataset['id']}&days=7")
        quality_export = client.get(f"/api/exports/quality?dataset_id={dataset['id']}")
        assert metric_export.headers["content-type"].startswith("text/csv")
        assert "metric,value,change_percent" in metric_export.text
        assert quality_export.headers["content-type"].startswith("text/csv")


def test_ai_uses_real_mcp_tool_and_returns_evidence(database, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    dataset = analytics.list_datasets()[0]
    response = asyncio.run(api.ai_chat(api.ChatRequest(dataset_id=dataset["id"], message="Summarize this dataset")))
    assert response["provider"] == "rule-based"
    assert response["tool"] == "inspect_dataset"
    assert response["evidence"]["shape"]["rows"] > 0


def test_quality_chat_summary_explains_each_finding():
    answer = api._summarize("get_data_quality_report", {
        "score": 100.0,
        "row_count": 5110,
        "issues": [
            {
                "type": "type_inconsistency",
                "column": "bmi",
                "count": 201,
                "severity": "medium",
                "description": "201 non-numeric value(s) occur in a numeric column.",
                "recommendation": "Review source values and correct or explicitly map non-numeric entries.",
            },
            {
                "type": "statistical_outliers",
                "column": None,
                "count": 100,
                "severity": "low",
                "description": "100 numeric outlier warning(s) flagged by z-score.",
                "recommendation": "Review these statistical warnings; they are not proof of data errors.",
            },
        ],
    })

    assert "201 non-numeric value(s)" in answer
    assert "- bmi: 201 non-numeric" in answer
    assert "100 numeric outlier warning(s)" in answer
    assert "does not include type inconsistencies or statistical outlier warnings" in answer


def test_metrics_quality_and_search_cover_entire_dataset(database):
    today = date.today().isoformat()
    content = "order_date,revenue,customer_id\n" + "".join(
        f"{today},1,C{index}-needle-record\n" if index == 1104 else f"{today},1,C{index}\n"
        for index in range(1105)
    )
    dataset = upload(database, "large.csv", content)
    result = analytics.metrics(dataset["id"], 7)
    assert result["metrics"]["revenue"] == 1105
    assert result["metrics"]["active_customers"] == 1105
    assert analytics.quality_report(dataset["id"])["row_count"] == 1105
    matches = analytics.search_dataset(dataset["id"], "needle-record")
    assert matches["count"] == 1
    assert matches["matches"][0]["customer_id"] == "C1104-needle-record"


def test_readonly_sql_blocks_unapproved_functions(database):
    dataset = upload(database, "safe.csv", "value\n1\n")
    with pytest.raises(ValueError, match="function that is not permitted"):
        analytics.run_readonly_sql(dataset["id"], "SELECT randomblob(1000000)")


def test_ai_product_question_runs_analytical_mcp_query(database, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    dataset = analytics.list_datasets()[0]
    response = asyncio.run(api.ai_chat(api.ChatRequest(
        dataset_id=dataset["id"],
        message="Which products generated the highest revenue?",
    )))
    assert response["tool"] == "run_readonly_sql"
    assert "GROUP BY" in response["evidence"]["query"]
    assert response["evidence"]["rows"]


def test_missing_date_or_order_fields_are_not_reported_as_period_metrics(database):
    dataset = upload(database, "totals.csv", "revenue\n10\n15\n")
    result = analytics.metrics(dataset["id"], 7)
    assert result["metrics"]["revenue"] == 25
    assert result["metrics"]["orders"] is None
    assert result["metrics"]["average_order_value"] is None
    assert result["previous_period"]["metrics"]["revenue"] is None
    assert result["comparison"]["revenue"]["absolute_change"] is None


def test_configured_llm_uses_only_server_side_provider_configuration(monkeypatch):
    sent = {}

    class FakeResponse:
        is_error = False

        def json(self):
            return {"choices": [{"message": {"content": "Revenue decreased in the compared window."}}]}

    class FakeClient:
        def __init__(self, timeout):
            assert timeout == 25

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, headers, json):
            sent.update({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setenv("OPENAI_API_KEY", "test-only-secret")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://llm.example/v1/")
    monkeypatch.setattr(api.httpx, "AsyncClient", FakeClient)
    answer = asyncio.run(api._complete_with_llm("Why?", "compare_periods", {"change": -10}))
    assert answer == "Revenue decreased in the compared window."
    assert sent["url"] == "https://llm.example/v1/chat/completions"
    assert sent["headers"]["Authorization"] == "Bearer test-only-secret"
    assert "test-only-secret" not in sent["json"]["messages"][1]["content"]


def test_empty_dataset_has_no_quality_score(database):
    dataset = upload(database, "empty.csv", "id,value\n")
    quality = analytics.quality_report(dataset["id"])
    assert quality["row_count"] == 0
    assert quality["score"] is None
    assert "empty dataset" in quality["calculation"].lower()


def test_quality_reports_invalid_dates_mixed_numeric_values_and_outliers(database):
    dataset = upload(
        database,
        "validation.csv",
        "order_date,amount\n2026-10-18,10\n2026-10-17,11\n2026-10-16,12\n2026-10-15,13\nnot-a-date,bad\n",
    )
    report = analytics.quality_report(dataset["id"])
    assert {issue["type"] for issue in report["issues"]} >= {"invalid_dates", "type_inconsistency"}
    amount = next(column for column in report["columns"] if column["name"] == "amount")
    assert amount["type_inconsistencies"] == 1
    assert next(column for column in report["columns"] if column["name"] == "order_date")["invalid_dates"] == 1
    assert report["score"] == 100

    anomaly_data = "amount\n" + "10\n" * 20 + "1000\n"
    anomaly_dataset = upload(database, "outliers.csv", anomaly_data)
    anomalies = analytics.detect_anomalies(anomaly_dataset["id"])
    assert anomalies["rows_scanned"] == 21
    assert anomalies["anomalies"][0]["observed_value"] == 1000
    assert any(issue["type"] == "statistical_outliers" for issue in analytics.quality_report(anomaly_dataset["id"])["issues"])


def test_anomaly_detection_skips_binary_and_identifier_columns(database):
    rows = ["id,hypertension,amount"]
    rows.extend(
        f"{1000000 if index == 20 else index + 1},{1 if index == 20 else 0},{1000 if index == 20 else 10}"
        for index in range(21)
    )
    dataset = upload(database, "binary-and-id.csv", "\n".join(rows) + "\n")

    report = analytics.detect_anomalies(dataset["id"])

    assert [finding["column"] for finding in report["anomalies"]] == ["amount"]
    assert "excluding binary 0/1 fields" in report["method"]


def test_studio_detects_schema_and_aggregates_filtered_chart_data(database):
    dataset = upload(
        database,
        "studio.csv",
        "category,age,stroke,score,order_date\n"
        "A,20,1,2.5,2024-01-01\n"
        "A,30,0,4.5,2024-01-02\n"
        "B,40,1,6.0,2024-01-03\n",
    )
    capabilities = studio.dataset_capabilities(dataset["id"])
    kinds = {column["name"]: column["kind"] for column in capabilities["columns"]}
    assert kinds == {
        "category": "categorical",
        "age": "numeric",
        "stroke": "boolean",
        "score": "numeric",
        "order_date": "date",
    }
    result = studio.aggregate_dataset(dataset["id"], {
        "type": "bar",
        "title": "Stroke rate by category",
        "x_field": "category",
        "y_field": "stroke",
        "aggregation": "avg",
        "sort": "asc",
        "filters": [{"field": "age", "operator": "gte", "value": 30}],
    })
    assert result["rows"] == [{"category": "A", "value": 0.0}, {"category": "B", "value": 1.0}]

    trend = studio.aggregate_dataset(dataset["id"], {
        "type": "line",
        "title": "Scores over time",
        "x_field": "order_date",
        "y_field": "score",
        "aggregation": "sum",
    })
    assert [row["category"] for row in trend["rows"]] == ["2024-01-01", "2024-01-02", "2024-01-03"]

    date_filtered = studio.aggregate_dataset(dataset["id"], {
        "type": "kpi",
        "title": "Records since January 2",
        "aggregation": "count",
        "filters": [{"field": "order_date", "operator": "gte", "value": "2024-01-02"}],
    })
    assert date_filtered["rows"] == [{"value": 2}]


def test_studio_histogram_correlation_and_recommendations(database):
    dataset = upload(
        database,
        "numbers.csv",
        "group,x,y\nA,1,2\nA,2,4\nB,3,6\nB,4,8\n",
    )
    histogram = studio.aggregate_dataset(dataset["id"], {
        "type": "histogram", "title": "X distribution", "x_field": "x", "aggregation": "count", "bins": 2,
    })
    assert sum(row["value"] for row in histogram["rows"]) == 4

    correlation = studio.aggregate_dataset(dataset["id"], {
        "type": "correlation", "title": "Correlation", "fields": ["x", "y"], "aggregation": "count",
    })
    assert correlation["rows"][0]["values"] == [1.0, 1.0]
    assert correlation["rows"][1]["values"] == [1.0, 1.0]
    assert any(item["type"] == "scatter" for item in studio.recommend_visualizations(dataset["id"])["recommendations"])


def test_studio_natural_language_honors_requested_donut_chart(database):
    dataset = upload(database, "donut.csv", "category,value\nA,10\nB,20\n")
    intent = studio.analyze_question(dataset["id"], "Create a donut chart")
    assert intent["kind"] == "visualization"
    assert intent["config"]["type"] == "donut"
    assert intent["config"]["x_field"] == "category"


def test_studio_validates_filters_and_paginates_search_results(database):
    dataset = upload(database, "records.csv", "name,value\nalpha,10\nbeta,20\nmatch_value,30\n")
    with pytest.raises(ValueError, match="requires a numeric or date field"):
        studio.validate_config({
            "type": "kpi", "aggregation": "count",
            "filters": [{"field": "name", "operator": "gte", "value": 1}],
        }, studio.dataset_capabilities(dataset["id"]))
    records = studio.paginated_records(dataset["id"], offset=0, limit=1, search="match")
    assert records["total"] == 1
    assert records["rows"] == [{"name": "match_value", "value": 30}]
    with pytest.raises(ValueError, match="limit"):
        studio.paginated_records(dataset["id"], limit=201)


def test_studio_reports_save_load_update_and_delete(database):
    dataset = upload(database, "report-data.csv", "category,value\nA,10\nB,20\n")
    config = {
        "id": "chart-1", "type": "bar", "title": "Value by category",
        "x_field": "category", "y_field": "value", "aggregation": "sum", "filters": [],
    }
    saved = studio.save_report({
        "title": "First report", "dataset_id": dataset["id"], "visualizations": [config],
        "filters": [{"field": "category", "operator": "eq", "value": "A"}],
    })
    assert studio.get_report(saved["id"])["visualizations"][0]["x_field"] == "category"
    assert studio.get_report(saved["id"])["filters"] == [{"field": "category", "operator": "eq", "value": "A"}]
    with pytest.raises(ValueError, match="does not exist"):
        studio.save_report({
            "title": "Invalid report", "dataset_id": dataset["id"], "visualizations": [],
            "filters": [{"field": "missing", "operator": "eq", "value": "A"}],
        })
    updated = studio.save_report({
        "id": saved["id"], "title": "Updated report", "dataset_id": dataset["id"],
        "visualizations": [], "filters": [],
    }, saved["id"])
    assert updated["created_at"] == saved["created_at"]
    assert studio.get_report(saved["id"])["title"] == "Updated report"
    assert studio.list_reports()[0]["id"] == saved["id"]
    studio.delete_report(saved["id"])
    with pytest.raises(ValueError, match="not found"):
        studio.get_report(saved["id"])


def test_studio_api_uses_mcp_for_natural_language_visualization(database, monkeypatch):
    dataset = upload(database, "ask-data.csv", "category,value\nA,10\nB,20\n")
    invoked = {}

    async def fake_tool(name, arguments):
        invoked.update({"name": name, "arguments": arguments})
        return studio.aggregate_dataset(arguments["dataset_id"], arguments["config"])

    monkeypatch.setattr(api, "_call_mcp_tool", fake_tool)
    with TestClient(api.app) as client:
        response = client.post("/api/analytics/ask", json={
            "dataset_id": dataset["id"], "question": "Show records by category",
        })
    assert response.status_code == 200
    assert invoked["name"] == "aggregate_dataset"
    assert response.json()["visualization"]["rows"]
    assert response.json()["provider"] == "rule-based"
