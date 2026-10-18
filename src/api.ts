export interface Dataset {
  id: string;
  name: string;
  row_count: number;
  column_count: number;
  uploaded_at: string;
  status: string;
  source_dataset_id?: string | null;
  role?: 'working_copy' | 'saved_copy' | null;
  is_working_copy?: boolean;
}

export interface DatasetDetail {
  dataset: Dataset;
  shape: { rows: number; columns: number };
  columns: Array<{ name: string; type: string }>;
  schema: Record<string, string>;
  sample: Array<Record<string, unknown>>;
}

export interface MetricResponse {
  dataset_id: string;
  period: { start: string; end: string; days: number };
  metrics: {
    revenue: number | null;
    active_customers: number | null;
    orders: number | null;
    average_order_value: number | null;
  };
  previous_period: { start: string; end: string; metrics: Record<string, number | null> };
  comparison: Record<string, { absolute_change: number | null; percent_change: number | null }>;
  series: Array<{ date: string; revenue: number }>;
  previous_series: Array<{ date: string; revenue: number }>;
  supported: { revenue: boolean; customers: boolean; dates: boolean };
}

export interface QualityReport {
  dataset_id: string;
  score: number | null;
  row_count: number;
  duplicate_count: number;
  missing_values: number;
  calculation: string;
  columns: Array<{
    name: string;
    type: string;
    missing: number;
    missing_percent: number;
    unique: number;
    type_inconsistencies: number;
    invalid_dates: number;
    statistics: { min: number | null; max: number | null; mean: number | null };
  }>;
  issues: Array<{
    type: string;
    column: string | null;
    count: number;
    severity: string;
    description: string;
    recommendation: string;
  }>;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  duration_ms: number;
  truncated: boolean;
}

export interface ChatResponse {
  answer: string;
  provider: string;
  tool: string;
  evidence: Record<string, unknown>;
  limitations: string;
}

export interface SearchResponse {
  matches: Array<Record<string, unknown>>;
  count: number;
  truncated: boolean;
}

export interface QueryHistoryEntry {
  dataset_id: string;
  query: string;
  executed_at: string;
  row_count: number;
  duration_ms: number;
}

export type VisualizationType =
  | 'bar' | 'horizontal_bar' | 'grouped_bar' | 'stacked_bar' | 'line' | 'area'
  | 'pie' | 'donut' | 'scatter' | 'histogram' | 'heatmap' | 'box_plot'
  | 'table' | 'kpi' | 'gauge' | 'correlation';

export interface VisualizationConfig {
  id?: string;
  title: string;
  type: VisualizationType;
  x_field?: string;
  y_field?: string;
  legend_field?: string;
  fields?: string[];
  aggregation: 'count' | 'distinct_count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
  filters: Array<{ field: string; operator: string; value?: unknown }>;
  sort?: 'asc' | 'desc';
  top_n?: number;
  bins?: number;
  bin_size?: number;
  format?: 'number' | 'currency' | 'percent';
  palette?: 'cyan' | 'emerald' | 'violet';
}

export interface DatasetCapabilities {
  dataset_id: string;
  dataset: Dataset;
  shape: { rows: number; columns: number };
  columns: Array<{
    name: string; type: string; kind: 'date' | 'identifier' | 'numeric' | 'boolean' | 'categorical';
    unique: number; missing: number; missing_percent: number;
    minimum: number | null; maximum: number | null;
  }>;
  roles: { date_fields: string[]; measures: string[]; dimensions: string[]; identifiers: string[] };
  business_metrics: Record<string, boolean>;
}

export interface AggregateResult {
  config: VisualizationConfig;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  metadata: Record<string, unknown>;
}

export interface VisualizationRecommendation {
  id: string;
  question: string;
  type: VisualizationType;
  config: VisualizationConfig;
  required_fields: string[];
  reason: string;
}

export interface SavedReport {
  id: string;
  title: string;
  dataset_id: string;
  created_at: string;
  updated_at: string;
  visualizations?: VisualizationConfig[];
  filters?: Array<{ field: string; operator: string; value?: unknown }>;
  dataset_available?: boolean;
}

export interface DatasetRecords {
  total: number;
  offset: number;
  limit: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface EditorColumn {
  name: string;
  type: string;
}

export interface EditorRecords {
  dataset: Dataset;
  columns: EditorColumn[];
  row_key: string;
  total: number;
  offset: number;
  limit: number;
  rows: Array<Record<string, unknown>>;
}

export type EditorOperation =
  | { type: 'set_cells'; cells: Array<{ row_id: number | string; column: string; value: unknown }> }
  | { type: 'insert_rows'; rows: Array<{ id?: number | string; values: Record<string, unknown> }> }
  | { type: 'delete_rows'; row_ids: Array<number | string> }
  | { type: 'add_column'; name: string; column_type: 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'DATE' }
  | { type: 'delete_column'; name: string }
  | { type: 'rename_column'; old_name: string; name: string }
  | { type: 'convert_column'; name: string; column_type: 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'DATE' };

export interface EditorSaveResult {
  row_id_map: Record<string, number>;
  inverse_operations: EditorOperation[];
  operations: EditorOperation[];
  dataset: Dataset;
}

export interface EditorTransformPreview {
  kind: string;
  columns: string[];
  columns_added: string[];
  columns_removed: string[];
  affected_cells: number;
  affected_rows: number;
  rows_removed: number;
  examples: Array<{ row_id: number | string; column: string; before: unknown; after: unknown }>;
  warnings: string[];
  type_changes: Array<{ column: string; from: string; to: string }>;
  operations: EditorOperation[];
  inverse_operations: EditorOperation[];
}

export interface EditorTransformationHistory {
  operation: string;
  columns: string[];
  affected_cells: number;
  affected_rows: number;
  created_at: string;
  applied: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      typeof payload === 'object' && payload !== null && 'detail' in payload
        ? String(payload.detail)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  datasets: () => request<Dataset[]>('/api/datasets'),
  metrics: (id: string, days: number, start?: string, end?: string) => {
    const params = new URLSearchParams({ days: String(days) });
    if (start && end) {
      params.set('start_date', start);
      params.set('end_date', end);
    }
    return request<MetricResponse>(`/api/datasets/${encodeURIComponent(id)}/metrics?${params}`);
  },
  detail: (id: string) => request<DatasetDetail>(`/api/datasets/${encodeURIComponent(id)}`),
  capabilities: (id: string) =>
    request<DatasetCapabilities>(`/api/datasets/${encodeURIComponent(id)}/capabilities`),
  records: (id: string, offset: number, limit: number, search = '') =>
    request<DatasetRecords>(`/api/datasets/${encodeURIComponent(id)}/records?${new URLSearchParams({ offset: String(offset), limit: String(limit), search })}`),
  createEditorWorkingCopy: (id: string) =>
    request<Dataset>(`/api/datasets/${encodeURIComponent(id)}/editor/working-copy`, { method: 'POST' }),
  editorRecords: (
    id: string,
    offset: number,
    limit: number,
    search = '',
    sort = '',
    direction: 'asc' | 'desc' = 'asc',
    filterColumn = '',
    filterValue = '',
  ) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit), search, direction });
    if (sort) params.set('sort', sort);
    if (filterColumn) params.set('filter_column', filterColumn);
    if (filterValue) params.set('filter_value', filterValue);
    return request<EditorRecords>(`/api/datasets/${encodeURIComponent(id)}/editor/records?${params}`);
  },
  previewEditorTransformation: (
    id: string,
    transform: Record<string, unknown>,
    operations: EditorOperation[],
  ) =>
    request<EditorTransformPreview>(`/api/datasets/${encodeURIComponent(id)}/editor/transform/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transform, operations }),
    }),
  editorTransformationHistory: (id: string) =>
    request<EditorTransformationHistory[]>(`/api/datasets/${encodeURIComponent(id)}/editor/transform/history`),
  saveEditorChanges: (
    id: string,
    operations: EditorOperation[],
    transformationHistory: Array<{
      operation: string;
      columns: string[];
      affected_cells: number;
      affected_rows: number;
    }> = [],
  ) =>
    request<EditorSaveResult>(`/api/datasets/${encodeURIComponent(id)}/editor/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations, transformation_history: transformationHistory }),
    }),
  saveEditorAs: (
    id: string,
    name: string,
    operations: EditorOperation[],
    transformationHistory: Array<{
      operation: string;
      columns: string[];
      affected_cells: number;
      affected_rows: number;
    }> = [],
  ) =>
    request<Dataset>(`/api/datasets/${encodeURIComponent(id)}/editor/save-as`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, operations, transformation_history: transformationHistory }),
    }),
  restoreOriginal: (id: string) =>
    request<Dataset>(`/api/datasets/${encodeURIComponent(id)}/editor/restore-original`, { method: 'POST' }),
  downloadEditorCsv: async (id: string, operations: EditorOperation[] = []): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(operations.length
      ? `/api/datasets/${encodeURIComponent(id)}/editor/export`
      : `/api/datasets/${encodeURIComponent(id)}/editor/download`, operations.length
      ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations }),
      }
      : undefined);
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message = typeof payload === 'object' && payload !== null && 'detail' in payload
        ? String(payload.detail)
        : `CSV download failed (${response.status})`;
      throw new Error(message);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? 'dataset.csv';
    return { blob: await response.blob(), filename };
  },
  recommendations: (id: string) =>
    request<{ recommendations: VisualizationRecommendation[] }>(`/api/datasets/${encodeURIComponent(id)}/recommendations`),
  aggregate: (id: string, config: VisualizationConfig) =>
    request<AggregateResult>(`/api/datasets/${encodeURIComponent(id)}/aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }),
  reports: () => request<SavedReport[]>('/api/reports'),
  report: (id: string) => request<SavedReport & { visualizations: VisualizationConfig[] }>('/api/reports/' + encodeURIComponent(id)),
  saveReport: (report: { id?: string; title: string; dataset_id: string; visualizations: VisualizationConfig[]; filters?: Array<{ field: string; operator: string; value?: unknown }> }) =>
    request<SavedReport>('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }),
  deleteReport: (id: string) =>
    request<{ deleted: boolean }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  askAnalytics: (dataset_id: string, question: string) =>
    request<{
      kind: 'visualization' | 'quality' | 'recommendations' | 'clarification';
      config?: VisualizationConfig;
      visualization?: AggregateResult;
      answer?: unknown;
      explanation?: string;
      tool?: string;
      provider: string;
    }>('/api/analytics/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset_id, question }),
    }),
  search: (id: string, term: string) =>
    request<SearchResponse>(`/api/datasets/${encodeURIComponent(id)}/search?q=${encodeURIComponent(term)}`),
  quality: (id: string) => request<QualityReport>(`/api/datasets/${encodeURIComponent(id)}/quality`),
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Dataset>('/api/datasets/upload', { method: 'POST', body: form });
  },
  execute: (dataset_id: string, query: string) =>
    request<QueryResult>('/api/sql/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset_id, query }),
    }),
  sqlHistory: (datasetId: string) =>
    request<QueryHistoryEntry[]>(`/api/sql/history?dataset_id=${encodeURIComponent(datasetId)}`),
  ask: (dataset_id: string, message: string) =>
    request<ChatResponse>('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset_id, message }),
    }),
};
