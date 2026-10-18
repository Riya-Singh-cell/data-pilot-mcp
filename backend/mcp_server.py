from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from backend import analytics, studio

mcp = FastMCP(
    "DataPilot MCP",
    instructions="Read-only business analytics tools for datasets stored in the DataPilot local workspace.",
)


@mcp.tool()
def list_datasets() -> list[dict[str, Any]]:
    """List datasets available in this local DataPilot workspace, including shape and upload time."""
    analytics.initialize()
    return analytics.list_datasets()


@mcp.tool()
def inspect_dataset(dataset_id: str) -> dict[str, Any]:
    """Inspect an approved dataset's schema, shape, inferred types, and up to five sample rows."""
    return analytics.inspect_dataset(dataset_id)


@mcp.tool()
def profile_data(dataset_id: str) -> dict[str, Any]:
    """Profile missingness, distinct counts, and numeric summary statistics by column."""
    return analytics.profile_data(dataset_id)


@mcp.tool()
def run_readonly_sql(dataset_id: str, query: str) -> dict[str, Any]:
    """Run one read-only SELECT query against only the selected dataset; results are capped at 1,000 rows."""
    return analytics.run_readonly_sql(dataset_id, query)


@mcp.tool()
def detect_anomalies(dataset_id: str) -> dict[str, Any]:
    """Detect extreme numeric values using a three-standard-deviation z-score screen; small samples are skipped."""
    return analytics.detect_anomalies(dataset_id)


@mcp.tool()
def compare_periods(dataset_id: str, days: int = 30) -> dict[str, Any]:
    """Compare supported business metrics over a period with the preceding period of equal length."""
    return analytics.compare_periods(dataset_id, days)


@mcp.tool()
def get_business_metrics(dataset_id: str, days: int = 30) -> dict[str, Any]:
    """Calculate only revenue, active customers, order count, and average order value supported by the schema."""
    return analytics.metrics(dataset_id, days)


@mcp.tool()
def search_dataset(dataset_id: str, term: str) -> dict[str, Any]:
    """Search approved dataset values for a case-insensitive term, returning at most 100 matching rows."""
    return analytics.search_dataset(dataset_id, term)


@mcp.tool()
def get_data_quality_report(dataset_id: str) -> dict[str, Any]:
    """Return reproducible missing-value and duplicate checks, a documented score, severities, and remediation."""
    return analytics.quality_report(dataset_id)


@mcp.tool()
def recommend_visualizations(dataset_id: str) -> dict[str, Any]:
    """Recommend only visualizations supported by the selected dataset's measured schema."""
    return studio.recommend_visualizations(dataset_id)


@mcp.tool()
def aggregate_dataset(dataset_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Validate a chart configuration, safely filter and aggregate the selected dataset, and return chart-ready data."""
    return studio.aggregate_dataset(dataset_id, config)


@mcp.resource("datapilot://datasets")
def dataset_catalog() -> str:
    """Metadata catalog of the datasets currently available in the workspace."""
    analytics.initialize()
    return json.dumps(analytics.list_datasets())


@mcp.prompt()
def business_summary(dataset_id: str) -> str:
    """Provide a reusable prompt for summarizing a dataset with evidence from registered tools."""
    return f"Inspect dataset {dataset_id}, calculate supported business metrics, profile data quality, and summarize evidence and limitations. Do not infer causation."


if __name__ == "__main__":
    analytics.initialize()
    mcp.run()
