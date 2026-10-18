# GradientHarbor — DataPilot MCP Analytics

GradientHarbor is a local business-intelligence demo built on the existing React/Vite/TypeScript dashboard. It provides CSV ingestion, dataset inspection, data profiling and quality checks, date-filtered business metrics, a restricted SQL workspace, and an evidence-backed rule-based analyst that invokes tools through the official MCP Python SDK.

## Requirements

- Node.js 18+
- Python 3.11+ (tested with Python 3.13)

## Run locally on Windows

From the repository root in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm ci
```

In one PowerShell window, start the FastAPI service:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.api:app --reload --host 127.0.0.1 --port 8000
```

In another window, start the Vite frontend:

```powershell
npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173`). The Vite development server proxies `/api` calls to the API on port 8000. FastAPI's OpenAPI UI is available at `http://127.0.0.1:8000/docs`; health is at `/api/health`.

The API creates a local SQLite database and seeds a synthetic `sample_sales.csv` dataset the first time it starts. By default the database is `backend\data.sqlite`. Set `DATAPILOT_DB_PATH` to change its location and `DATAPILOT_CORS_ORIGINS` to configure allowed browser origins. See [.env.example](./.env.example). These variables are read from the process environment; this repository does not automatically load a `.env` file.

For optional LLM-backed phrasing, set `OPENAI_API_KEY` on the backend process (and optionally `OPENAI_MODEL` and `OPENAI_BASE_URL`) before starting FastAPI. The API sends the selected MCP tool evidence and user's question to that configured OpenAI-compatible endpoint. If no key is present, responses are explicitly labeled rule-based; provider failures are returned as errors rather than being disguised as successful AI responses.

## Use the MCP server

The same analytics functions are exposed as nine tools by the official MCP Python SDK. To inspect the stdio server with MCP Inspector, start the Inspector and configure its server command as `python` with arguments `-m` and `backend.mcp_server`, using the repository root as the working directory. The server exposes `list_datasets`, `inspect_dataset`, `profile_data`, `run_readonly_sql`, `detect_anomalies`, `compare_periods`, `get_business_metrics`, `search_dataset`, and `get_data_quality_report`, plus a dataset catalog resource and business-summary prompt.

The analyst panel starts a real MCP stdio client session for each question, invokes a registered tool, and grounds its response in the returned evidence. Without the optional provider configuration, it uses a deterministic rule-based summary. API keys are only read by the backend and are never sent to the browser.

## Features and API

- `GET /api/datasets`, `POST /api/datasets/upload`, `GET /api/datasets/{id}`
- `GET /api/datasets/{id}/profile`, `/quality`, `/metrics`, and `/trends`
- `POST /api/sql/execute`, `GET /api/sql/history`
- `POST /api/ai/chat`
- `GET /api/exports/metrics`, `GET /api/exports/quality`
- `POST /api/datasets/{id}/editor/working-copy`, `/editor/changes`, `/editor/save-as`, `/editor/restore-original`
- `GET /api/datasets/{id}/editor/records`, `/editor/download`; `POST /editor/export`
- `POST /api/datasets/{id}/editor/transform/preview`, `GET /editor/transform/history`
- Dashboard presets for 7, 30, and 90 days and inclusive custom date ranges
- Exportable metric, data-quality, and SQL-result CSV files

CSV upload is limited to 10 MB and UTF-8 files. XLSX is not enabled. Date and revenue columns are recognized by common names (for example, `order_date` and `revenue`); unsupported metrics are shown as unavailable rather than invented. SQL accepts a single query against the selected dataset's generated table, uses a SQLite authorizer to reject writes and other tables, and caps results at 1,000 rows. No uploaded file path or SQL is used to choose an on-disk path.

In **Datasets**, choose **Edit Dataset** to open a spreadsheet editor for an isolated working copy. Cell, row, and column edits remain staged until **Save Changes**; undo/redo (including Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z), search, filtering, sorting, CSV download, and **Discard changes** are available before saving. The original dataset is never modified. **Save As New Dataset** creates another independent dataset version, and **Restore Original** resets only the working copy after confirmation. Selecting a saved working copy makes its version available to dashboard metrics, analytics, SQL, and data-quality reports; existing reports and other datasets retain their original dataset IDs.

The editor's **Transform Data** panel previews changes against the working copy and any staged edits before applying them as a single undoable action. It supports exact/contains replacement, typed missing-value fills (literal, mean, median, or mode), conditional updates, text normalization, rounding, type conversion (TEXT, INTEGER, REAL, BOOLEAN, DATE), row and missing-column removal, duplicate removal, column rename/split/combine, and calculated numeric columns. Calculated expressions are parsed with a restricted arithmetic grammar; arbitrary code is not evaluated. Bulk previews return bounded examples, type validation errors, counts, and warnings. Changes are staged locally until saved, and the original remains unchanged. The current-session undo stack is bounded to 100 actions; transformation audit entries are persisted on **Save Changes**, but undo history itself is not persisted across editor restarts.

Quality score is calculated as `100 × (1 − missing cells / total cells) − duplicate rows / rows × 100`, bounded to 0–100 (unavailable for a dataset with no rows). The report also flags non-numeric values in mostly numeric columns, invalid values in recognized date columns, and numeric outliers using a population z-score threshold of `|z| >= 3`. Type/date findings are objective validation checks; outliers are statistical warnings and are not counted in the quality score. It does not modify source records.

## Tests and checks

```powershell
.\.venv\Scripts\Activate.ps1
python -m pytest -q
npm run typecheck
npm run lint
npm run build
```

## Deployment and security limitations

This is a local demo, not a production deployment. It has no authentication or dataset ownership enforcement; all datasets in the configured database are visible to the local service. Do not expose it to untrusted networks without adding authentication, authorization, operational limits, backups, and deployment-specific security controls. CORS is restricted to the configured origin list, but CORS is not authentication. Upload and SQL errors are returned as validation messages; database stack traces are not intentionally returned.
