import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from backend import analytics, api, editor


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / "editor.sqlite"
    monkeypatch.setattr(analytics, "DB_PATH", path)
    analytics.initialize()
    return path


def upload(name="original.csv", body='name,count,notes\nalpha,1,"comma, quote ""and"" newline"\nbeta,2,\n'):
    return analytics.ingest_csv(name, body.encode("utf-8"))


def values(dataset_id):
    with analytics.connect_readonly() as connection:
        table = analytics._quote(analytics._table_name(dataset_id))
        return [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]


def test_cell_changes_undo_redo_and_never_mutates_original(database):
    original = upload()
    working = editor.ensure_working_copy(original["id"])
    page = editor.editor_records(working["id"])
    first_id = page["rows"][0][page["row_key"]]
    change = {"type": "set_cells", "cells": [{"row_id": first_id, "column": "name", "value": "edited"}]}

    committed = editor.apply_edits(working["id"], [change])
    assert values(working["id"])[0]["name"] == "edited"
    assert values(original["id"])[0]["name"] == "alpha"

    undone = editor.apply_edits(working["id"], committed["inverse_operations"])
    assert values(working["id"])[0]["name"] == "alpha"
    editor.apply_edits(working["id"], undone["inverse_operations"])
    assert values(working["id"])[0]["name"] == "edited"


def test_rows_columns_and_column_names_are_reversible(database):
    original = upload()
    working = editor.ensure_working_copy(original["id"])
    rows = editor.editor_records(working["id"])["rows"]
    first_id = rows[0]["__datapilot_editor_row_id__"]
    operations = [
        {"type": "insert_rows", "rows": [{"id": "new-row", "values": {"name": "gamma", "count": 3, "notes": "new"}}]},
        {"type": "add_column", "name": "extra", "column_type": "TEXT"},
        {"type": "set_cells", "cells": [{"row_id": "new-row", "column": "extra", "value": "extra-value"}]},
        {"type": "rename_column", "old_name": "extra", "name": "renamed extra"},
        {"type": "delete_rows", "row_ids": [first_id]},
        {"type": "delete_column", "name": "notes"},
    ]
    result = editor.apply_edits(working["id"], operations)
    changed = editor.editor_records(working["id"])
    assert changed["total"] == 2
    assert [column["name"] for column in changed["columns"]] == ["name", "count", "renamed_extra"]
    assert next(row for row in changed["rows"] if row["name"] == "gamma")["renamed_extra"] == "extra-value"

    undone = editor.apply_edits(working["id"], result["inverse_operations"])
    restored = editor.editor_records(working["id"])
    assert restored["total"] == 2
    assert [column["name"] for column in restored["columns"]] == ["name", "count", "notes"]
    assert {row["name"] for row in restored["rows"]} == {"alpha", "beta"}

    redone = editor.apply_edits(working["id"], undone["inverse_operations"])
    assert editor.editor_records(working["id"])["columns"] == changed["columns"]
    assert redone["dataset"]["row_count"] == 2


def test_validation_failure_rolls_back_entire_edit_batch(database):
    original = upload()
    working = editor.ensure_working_copy(original["id"])
    row_id = editor.editor_records(working["id"])["rows"][0]["__datapilot_editor_row_id__"]
    with pytest.raises(ValueError, match="whole number"):
        editor.apply_edits(working["id"], [
            {"type": "set_cells", "cells": [{"row_id": row_id, "column": "name", "value": "should rollback"}]},
            {"type": "set_cells", "cells": [{"row_id": row_id, "column": "count", "value": "1.5"}]},
        ])
    assert values(working["id"])[0]["name"] == "alpha"


def test_save_as_is_separate_and_csv_export_includes_staged_edits(database):
    original = upload()
    working = editor.ensure_working_copy(original["id"])
    row_id = editor.editor_records(working["id"])["rows"][0]["__datapilot_editor_row_id__"]
    operations = [
        {"type": "set_cells", "cells": [{"row_id": row_id, "column": "name", "value": "edited, value"}]},
        {"type": "set_cells", "cells": [{"row_id": row_id, "column": "notes", "value": 'say "hello"\nnext line'}]},
    ]
    csv_text, filename = editor.export_csv(working["id"], operations)
    parsed = list(csv.reader(io.StringIO(csv_text, newline="")))
    assert filename == "original_edited.csv"
    assert parsed[1][0] == "edited, value"
    assert parsed[1][2] == 'say "hello"\nnext line'
    assert values(working["id"])[0]["name"] == "alpha"

    saved = editor.save_as(
        working["id"],
        "analysis-copy.csv",
        operations,
        [{
            "operation": "Replace alpha with edited value",
            "columns": ["name"],
            "affected_cells": 1,
            "affected_rows": 1,
        }],
    )
    assert saved["name"] == "analysis-copy.csv"
    assert values(saved["id"])[0]["name"] == "edited, value"
    assert values(original["id"])[0]["name"] == "alpha"
    assert values(working["id"])[0]["name"] == "alpha"
    listed = {dataset["id"]: dataset for dataset in analytics.list_datasets()}
    assert listed[saved["id"]]["role"] == "saved_copy"
    assert editor.get_transformation_history(saved["id"])[0]["operation"] == "Replace alpha with edited value"


def test_changes_persist_after_reinitialize_and_integrations_use_selected_version(database):
    original = upload("quality.csv", "category,value\nA,10\nB,20\n")
    working = editor.ensure_working_copy(original["id"])
    row_id = editor.editor_records(working["id"])["rows"][0]["__datapilot_editor_row_id__"]
    editor.apply_edits(working["id"], [
        {"type": "set_cells", "cells": [{"row_id": row_id, "column": "value", "value": 100}]},
        {"type": "insert_rows", "rows": [{"id": "added", "values": {"category": "C", "value": 30}}]},
    ])

    analytics.initialize()
    assert values(working["id"])[0]["value"] == 100
    assert values(original["id"])[0]["value"] == 10
    assert analytics.inspect_dataset(working["id"])["shape"] == {"rows": 3, "columns": 2}
    assert analytics.quality_report(working["id"])["row_count"] == 3
    table = f"dataset_{working['id'].replace('-', '')}"
    query = analytics.run_readonly_sql(working["id"], f"SELECT SUM(value) AS total FROM {table}")
    assert query["rows"] == [{"total": 150}]
    assert analytics.run_readonly_sql(original["id"], f"SELECT SUM(value) AS total FROM dataset_{original['id'].replace('-', '')}")["rows"] == [{"total": 30}]

    from backend.mcp_server import inspect_dataset

    assert inspect_dataset(working["id"])["shape"]["rows"] == 3


def test_restore_original_resets_only_working_copy(database):
    original = upload()
    working = editor.ensure_working_copy(original["id"])
    row_id = editor.editor_records(working["id"])["rows"][0]["__datapilot_editor_row_id__"]
    editor.apply_edits(working["id"], [
        {"type": "set_cells", "cells": [{"row_id": row_id, "column": "name", "value": "changed"}]},
        {"type": "add_column", "name": "extra", "column_type": "TEXT"},
    ])
    editor.restore_original(working["id"])
    assert values(working["id"]) == values(original["id"])
    assert [item["name"] for item in analytics.inspect_dataset(working["id"])["columns"]] == ["name", "count", "notes"]
    assert values(original["id"])[0]["name"] == "alpha"


def test_editor_api_creates_copy_saves_changes_and_downloads_csv(database):
    original = upload()
    with TestClient(api.app) as client:
        working = client.post(f"/api/datasets/{original['id']}/editor/working-copy").json()
        records = client.get(f"/api/datasets/{working['id']}/editor/records?limit=1").json()
        row_id = records["rows"][0][records["row_key"]]
        edit_response = client.post(
            f"/api/datasets/{working['id']}/editor/changes",
            json={"operations": [{"type": "set_cells", "cells": [{"row_id": row_id, "column": "name", "value": "saved"}]}]},
        )
        assert edit_response.status_code == 200
        export = client.get(f"/api/datasets/{working['id']}/editor/download")
        assert export.status_code == 200
        assert next(csv.reader(io.StringIO(export.text)))[0] == "name"
        assert "saved" in export.text
        invalid = client.post(
            f"/api/datasets/{original['id']}/editor/changes",
            json={"operations": [{"type": "set_cells", "cells": [{"row_id": 1, "column": "name", "value": "unsafe"}]}]},
        )
        assert invalid.status_code == 400


def test_exact_numeric_replacement_preview_undo_redo_and_original_isolation(database):
    original = upload("numbers.csv", "code,amount\nA,2\nB,12\nC,20\nD,2.5\nE,2\n")
    working = editor.ensure_working_copy(original["id"])
    preview = editor.preview_transformation(working["id"], {
        "kind": "replace",
        "column": "amount",
        "find": "2",
        "replacement": "3",
        "match_mode": "exact",
        "match_case": True,
        "replace_all": True,
    })

    assert preview["affected_cells"] == 2
    assert preview["affected_rows"] == 2
    assert {item["before"] for item in preview["examples"]} == {2.0}
    assert [row["amount"] for row in values(original["id"])] == [2.0, 12.0, 20.0, 2.5, 2.0]

    applied = editor.apply_edits(working["id"], preview["operations"])
    assert [row["amount"] for row in values(working["id"])] == [3.0, 12.0, 20.0, 2.5, 3.0]
    editor.apply_edits(working["id"], preview["inverse_operations"])
    assert [row["amount"] for row in values(working["id"])] == [2.0, 12.0, 20.0, 2.5, 2.0]
    editor.apply_edits(working["id"], preview["operations"])
    assert applied["dataset"]["row_count"] == 5


def test_replace_missing_markers_is_explicit_and_type_validated(database):
    original = upload(
        "missing.csv",
        "bmi,smoking_status\n20,A\nN/A,Unknown\n30,B\n,Unknown\n40,C\n50,D\n60,E\n70,F\n80,G\n",
    )
    working = editor.ensure_working_copy(original["id"])
    fill = editor.preview_transformation(working["id"], {
        "kind": "fill_missing",
        "column": "bmi",
        "fill_mode": "value",
        "replacement": "0",
        "markers": ["N/A", "NA", "null", "None"],
    })
    assert fill["affected_cells"] == 2
    editor.apply_edits(working["id"], fill["operations"])
    assert [row["bmi"] for row in values(working["id"])][1:4] == [0.0, 30.0, 0.0]

    default_markers = editor.preview_transformation(working["id"], {
        "kind": "fill_missing",
        "column": "smoking_status",
        "fill_mode": "value",
        "replacement": "never smoked",
        "markers": ["N/A", "NA", "null", "None"],
    })
    assert default_markers["affected_cells"] == 0
    explicit_marker = editor.preview_transformation(working["id"], {
        "kind": "fill_missing",
        "column": "smoking_status",
        "fill_mode": "value",
        "replacement": "never smoked",
        "markers": ["Unknown"],
    })
    assert explicit_marker["affected_cells"] == 2

    integer_dataset = upload("integer-mean.csv", "score,category\n1,A\n,B\n2,C\n")
    integer_working = editor.ensure_working_copy(integer_dataset["id"])
    mean_fill = editor.preview_transformation(integer_working["id"], {
        "kind": "fill_missing", "column": "score", "fill_mode": "mean", "markers": [],
    })
    assert mean_fill["warnings"]
    editor.apply_edits(integer_working["id"], mean_fill["operations"])
    assert [row["score"] for row in values(integer_working["id"])] == [1, 2, 2]


def test_conditional_update_preview_and_remove_missing_rows_are_reversible(database):
    original = upload("conditions.csv", "age,status,score\n61,ok,5\n60,ok,\n72,review,7\n")
    working = editor.ensure_working_copy(original["id"])
    update = editor.preview_transformation(working["id"], {
        "kind": "bulk_update",
        "target_column": "status",
        "replacement": "review",
        "condition": {"column": "age", "operator": "greater than", "value": "60"},
    })
    assert update["affected_rows"] == 1
    assert update["examples"][0]["before"] == "ok"
    editor.apply_edits(working["id"], update["operations"])
    assert values(working["id"])[0]["status"] == "review"

    removal = editor.preview_transformation(working["id"], {
        "kind": "remove_missing_rows",
        "column": "*",
        "markers": ["N/A", "NA", "null", "None"],
    })
    assert removal["rows_removed"] == 1
    editor.apply_edits(working["id"], removal["operations"])
    assert len(values(working["id"])) == 2
    editor.apply_edits(working["id"], removal["inverse_operations"])
    assert len(values(working["id"])) == 3
    assert values(original["id"])[0]["status"] == "ok"


def test_transform_preview_includes_pending_edits_and_audit_survives_restart(database):
    original = upload("audit.csv", "category,value\nA,1\nA,2\nB,3\n")
    working = editor.ensure_working_copy(original["id"])
    row_id = editor.editor_records(working["id"])["rows"][0]["__datapilot_editor_row_id__"]
    pending = [{"type": "set_cells", "cells": [{"row_id": row_id, "column": "category", "value": "Pending"}]}]
    preview = editor.preview_transformation(working["id"], {
        "kind": "replace",
        "column": "category",
        "find": "A",
        "replacement": "Changed",
        "match_mode": "exact",
        "match_case": True,
        "replace_all": True,
    }, pending)
    assert preview["affected_cells"] == 1
    assert preview["examples"][0]["before"] == "A"
    assert values(working["id"])[0]["category"] == "A"

    editor.apply_edits(
        working["id"],
        pending + preview["operations"],
        [{
            "operation": "Replace A with Changed",
            "columns": ["category"],
            "affected_cells": preview["affected_cells"],
            "affected_rows": preview["affected_rows"],
        }],
    )
    analytics.initialize()
    history = editor.get_transformation_history(working["id"])
    assert history[0]["operation"] == "Replace A with Changed"
    assert history[0]["columns"] == ["category"]
    assert history[0]["applied"] is True


def test_transformation_preview_api_validates_and_returns_examples(database):
    original = upload("api-transform.csv", "kind,value\nx,2\ny,12\n")
    working = editor.ensure_working_copy(original["id"])
    with TestClient(api.app) as client:
        response = client.post(
            f"/api/datasets/{working['id']}/editor/transform/preview",
            json={
                "transform": {
                    "kind": "replace", "column": "value", "find": "2",
                    "replacement": "3", "match_mode": "exact", "replace_all": True,
                },
                "operations": [],
            },
        )
        assert response.status_code == 200
        assert response.json()["affected_cells"] == 1
        assert response.json()["examples"][0]["before"] == 2
        assert client.get(f"/api/datasets/{working['id']}/editor/transform/history").json() == []


def test_type_conversion_is_previewed_reversible_and_rolls_back_invalid_values(database):
    original = upload("types.csv", "value\n1\n2\n3\n")
    working = editor.ensure_working_copy(original["id"])
    preview = editor.preview_transformation(working["id"], {
        "kind": "convert_type",
        "columns": ["value"],
        "target_type": "REAL",
    })
    assert preview["type_changes"] == [{"column": "value", "from": "INTEGER", "to": "REAL"}]
    editor.apply_edits(working["id"], preview["operations"])
    assert [column["type"] for column in analytics.inspect_dataset(working["id"])["columns"]] == ["REAL"]
    editor.apply_edits(working["id"], preview["inverse_operations"])
    assert [column["type"] for column in analytics.inspect_dataset(working["id"])["columns"]] == ["INTEGER"]
    assert [row["value"] for row in values(original["id"])] == [1, 2, 3]

    invalid = upload("invalid-types.csv", "value\none\ntwo\n")
    invalid_working = editor.ensure_working_copy(invalid["id"])
    with pytest.raises(ValueError, match="Cannot convert"):
        editor.preview_transformation(invalid_working["id"], {
            "kind": "convert_type",
            "columns": ["value"],
            "target_type": "INTEGER",
        })
    assert [row["value"] for row in values(invalid_working["id"])] == ["one", "two"]

    typed = upload("typed.csv", "active,observed\ntrue,2024-01-02\nfalse,2024-02-03\n")
    typed_working = editor.ensure_working_copy(typed["id"])
    for column, target_type in (("active", "BOOLEAN"), ("observed", "DATE")):
        conversion = editor.preview_transformation(typed_working["id"], {
            "kind": "convert_type", "columns": [column], "target_type": target_type,
        })
        editor.apply_edits(typed_working["id"], conversion["operations"])
    typed_columns = {column["name"]: column["type"] for column in analytics.inspect_dataset(typed_working["id"])["columns"]}
    assert typed_columns == {"active": "BOOLEAN", "observed": "DATE"}
    assert [row["active"] for row in values(typed_working["id"])] == [1, 0]


def test_split_combine_and_calculated_column_transformations_are_reversible(database):
    original = upload("transform-columns.csv", "first,second,amount\nA,1,10\nB,2,20\n")
    working = editor.ensure_working_copy(original["id"])

    split = editor.preview_transformation(working["id"], {
        "kind": "split_column", "column": "first", "delimiter": "-", "first_name": "left", "second_name": "right",
    })
    editor.apply_edits(working["id"], split["operations"])
    assert [row["left"] for row in values(working["id"])] == ["A", "B"]
    editor.apply_edits(working["id"], split["inverse_operations"])
    assert "left" not in values(working["id"])[0]

    combined = editor.preview_transformation(working["id"], {
        "kind": "combine_columns", "columns": ["first", "second"], "delimiter": "-", "new_name": "label",
    })
    editor.apply_edits(working["id"], combined["operations"])
    assert [row["label"] for row in values(working["id"])] == ["A-1", "B-2"]

    calculated = editor.preview_transformation(working["id"], {
        "kind": "calculate_column", "expression": "amount / 2 + 1", "new_name": "half_plus_one",
    })
    editor.apply_edits(working["id"], calculated["operations"])
    assert [row["half_plus_one"] for row in values(working["id"])] == [6.0, 11.0]
    assert [column["name"] for column in analytics.inspect_dataset(original["id"])["columns"]] == ["first", "second", "amount"]

    with pytest.raises(ValueError, match="Expression"):
        editor.preview_transformation(working["id"], {
            "kind": "calculate_column", "expression": "__import__('os').system('whoami')", "new_name": "unsafe",
        })


def test_remove_missing_columns_and_fill_all_only_uses_compatible_columns(database):
    original = upload("missing-columns.csv", "number,category\n1,A\n, B\n3,C\n")
    working = editor.ensure_working_copy(original["id"])
    remove = editor.preview_transformation(working["id"], {
        "kind": "remove_missing_columns",
        "markers": [],
    })
    assert remove["columns_removed"] == ["number"]

    fill = editor.preview_transformation(working["id"], {
        "kind": "fill_missing",
        "column": "*",
        "fill_mode": "value",
        "replacement": "0",
        "markers": [],
    })
    assert fill["columns"] == ["number", "category"]
    assert fill["affected_cells"] == 1
    editor.apply_edits(working["id"], fill["operations"])
    assert [row["number"] for row in values(working["id"])] == [1.0, 0.0, 3.0]
    assert [row["category"] for row in values(working["id"])] == ["A", "B", "C"]

    other_original = upload("missing-column-to-remove.csv", "present,missing\nA,\nB,\n")
    other_working = editor.ensure_working_copy(other_original["id"])
    remove = editor.preview_transformation(other_working["id"], {
        "kind": "remove_missing_columns",
        "markers": [],
    })
    assert remove["columns_removed"] == ["missing"]
    editor.apply_edits(other_working["id"], remove["operations"])
    assert [column["name"] for column in analytics.inspect_dataset(other_working["id"])["columns"]] == ["present"]
    assert [column["name"] for column in analytics.inspect_dataset(other_original["id"])["columns"]] == ["present", "missing"]


def test_normalize_preset_and_missing_removal_preview_are_supported(database):
    original = upload("normalize.csv", "category\n A \na\nB\n")
    working = editor.ensure_working_copy(original["id"])
    preview = editor.preview_transformation(working["id"], {
        "kind": "column", "action": "normalize", "columns": ["category"],
    })
    editor.apply_edits(working["id"], preview["operations"])
    assert [row["category"] for row in values(working["id"])] == ["a", "a", "b"]
    removal = editor.preview_transformation(working["id"], {
        "kind": "remove_missing_rows", "column": "*", "markers": [],
    })
    assert removal["rows_removed"] == 0


def test_saved_transform_updates_analytics_quality_sql_export_and_mcp_for_selected_copy(database):
    original = upload("analytics-transform.csv", "group,score\nA,10\nB,\nC,30\n")
    working = editor.ensure_working_copy(original["id"])
    preview = editor.preview_transformation(working["id"], {
        "kind": "fill_missing",
        "column": "score",
        "fill_mode": "value",
        "replacement": "0",
        "markers": [],
    })
    audit = [{
        "operation": "Replace missing score values with 0",
        "columns": preview["columns"],
        "affected_cells": preview["affected_cells"],
        "affected_rows": preview["affected_rows"],
    }]
    editor.apply_edits(working["id"], preview["operations"], audit)
    analytics.initialize()

    assert analytics.inspect_dataset(working["id"])["shape"] == {"rows": 3, "columns": 2}
    assert analytics.quality_report(working["id"])["missing_values"] == 0
    working_table = f"dataset_{working['id'].replace('-', '')}"
    assert analytics.run_readonly_sql(
        working["id"], f"SELECT SUM(score) AS total FROM {working_table}",
    )["rows"] == [{"total": 40}]
    original_table = f"dataset_{original['id'].replace('-', '')}"
    assert analytics.run_readonly_sql(
        original["id"], f"SELECT SUM(score) AS total FROM {original_table}",
    )["rows"] == [{"total": 40}]
    csv_text, _ = editor.export_csv(working["id"])
    assert "B,0" in csv_text

    from backend.mcp_server import get_data_quality_report, inspect_dataset

    assert inspect_dataset(working["id"])["shape"]["rows"] == 3
    assert get_data_quality_report(working["id"])["missing_values"] == 0
    assert editor.get_transformation_history(working["id"])[0]["operation"] == audit[0]["operation"]


def test_rename_and_numeric_range_flag_transformations(database):
    original = upload("range.csv", "age,score\n17,8\n35,12\n72,9\n")
    working = editor.ensure_working_copy(original["id"])
    renamed = editor.preview_transformation(working["id"], {
        "kind": "rename_column", "column": "age", "new_name": "participant_age",
    })
    editor.apply_edits(working["id"], renamed["operations"])
    assert "participant_age" in values(working["id"])[0]

    flagged = editor.preview_transformation(working["id"], {
        "kind": "flag_range",
        "column": "participant_age",
        "minimum": 18,
        "maximum": 65,
        "new_name": "age_review",
    })
    assert flagged["affected_cells"] == 2
    editor.apply_edits(working["id"], flagged["operations"])
    assert [row["age_review"] for row in values(working["id"])] == ["Review", None, "Review"]
    assert [row["age"] for row in values(original["id"])] == [17, 35, 72]
