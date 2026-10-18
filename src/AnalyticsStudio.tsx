import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowDown, ArrowUp, BarChart3, Check, CircleDot, Copy, Download,
  Filter, Gauge, Grid2X2, Hash, Layers2, LineChart, LoaderCircle, PieChart,
  Plus, RefreshCw, Save, ScatterChart, Search, Sparkles, Table2, Trash2,
  WandSparkles, X,
} from 'lucide-react';
import {
  api,
  type AggregateResult,
  type Dataset,
  type DatasetCapabilities,
  type SavedReport,
  type VisualizationConfig,
  type VisualizationRecommendation,
  type VisualizationType,
} from './api';

type ChartEntry = { config: VisualizationConfig; result?: AggregateResult; busy?: boolean; error?: string; wide?: boolean };
type FilterItem = { field: string; operator: string; value?: unknown };
const TYPE_OPTIONS: Array<{ type: VisualizationType; name: string; description: string; icon: typeof BarChart3 }> = [
  { type: 'bar', name: 'Bar chart', description: 'Compare category values', icon: BarChart3 },
  { type: 'horizontal_bar', name: 'Horizontal bar', description: 'Rank long category labels', icon: BarChart3 },
  { type: 'grouped_bar', name: 'Grouped bar', description: 'Compare series side by side', icon: Layers2 },
  { type: 'stacked_bar', name: 'Stacked bar', description: 'Show series composition', icon: Layers2 },
  { type: 'line', name: 'Line chart', description: 'Show changes across an axis', icon: LineChart },
  { type: 'area', name: 'Area chart', description: 'Show volume across an axis', icon: Activity },
  { type: 'pie', name: 'Pie chart', description: 'Show category share', icon: PieChart },
  { type: 'donut', name: 'Donut chart', description: 'Show share with a center total', icon: CircleDot },
  { type: 'scatter', name: 'Scatter plot', description: 'Explore two numeric measures', icon: ScatterChart },
  { type: 'histogram', name: 'Histogram', description: 'Explore a numeric distribution', icon: BarChart3 },
  { type: 'heatmap', name: 'Heatmap', description: 'Compare grouped values by intensity', icon: Grid2X2 },
  { type: 'box_plot', name: 'Box plot', description: 'Compare numeric quartiles', icon: Activity },
  { type: 'table', name: 'Data table', description: 'Inspect filtered source records', icon: Table2 },
  { type: 'kpi', name: 'KPI card', description: 'Summarize one measure', icon: Hash },
  { type: 'gauge', name: 'Gauge', description: 'Show one value against its range', icon: Gauge },
  { type: 'correlation', name: 'Correlation matrix', description: 'Compare numeric relationships', icon: Grid2X2 },
];
const PALETTES: Record<string, string[]> = {
  cyan: ['#38bdf8', '#2dd4bf', '#818cf8', '#fbbf24', '#fb7185', '#a3e635'],
  emerald: ['#34d399', '#22d3ee', '#a3e635', '#facc15', '#4ade80', '#14b8a6'],
  violet: ['#a78bfa', '#818cf8', '#c084fc', '#38bdf8', '#f472b6', '#2dd4bf'],
};
const FILTER_OPERATORS = [
  ['eq', 'is'], ['ne', 'is not'], ['contains', 'contains'],
  ['gte', '≥'], ['lte', '≤'], ['is_null', 'is empty'], ['not_null', 'is not empty'],
];

const fieldKind = (capabilities: DatasetCapabilities | null, name?: string) =>
  capabilities?.columns.find((column) => column.name === name)?.kind;
const filterFields = (capabilities: DatasetCapabilities | null) =>
  capabilities?.columns.map((column) => column.name) ?? [];

function makeId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function defaultConfig(type: VisualizationType, capabilities: DatasetCapabilities): VisualizationConfig {
  const columns = capabilities.columns;
  const dimensions = columns.filter((column) => ['categorical', 'boolean', 'date'].includes(column.kind));
  const numbers = columns.filter((column) => column.kind === 'numeric');
  const dates = columns.filter((column) => column.kind === 'date');
  const x = type === 'histogram'
    ? numbers[0]?.name
    : type === 'scatter'
      ? numbers[0]?.name
      : type === 'line' || type === 'area'
        ? dates[0]?.name ?? dimensions[0]?.name ?? numbers[0]?.name
        : dimensions[0]?.name ?? numbers[0]?.name;
  const config: VisualizationConfig = {
    id: makeId(),
    title: TYPE_OPTIONS.find((option) => option.type === type)?.name ?? 'Visualization',
    type,
    x_field: x,
    y_field: type === 'scatter' ? numbers[1]?.name : numbers[0]?.name,
    aggregation: type === 'scatter' || type === 'table' || type === 'correlation' ? 'count' : numbers.length && type !== 'pie' && type !== 'donut' ? 'sum' : 'count',
    filters: [],
    sort: type === 'line' ? 'asc' : 'desc',
    top_n: 15,
    bins: 20,
    palette: 'cyan',
    format: 'number',
  };
  if (type === 'kpi' || type === 'gauge') {
    config.x_field = undefined;
    config.y_field = numbers[0]?.name;
    config.aggregation = config.y_field ? 'avg' : 'count';
  }
  if (type === 'correlation') config.fields = numbers.slice(0, 12).map((column) => column.name);
  if (type === 'table') config.fields = columns.slice(0, 8).map((column) => column.name);
  return config;
}

export default function AnalyticsStudio({
  datasets,
  datasetId,
  onDatasetChange,
  onToast,
}: {
  datasets: Dataset[];
  datasetId: string;
  onDatasetChange: (datasetId: string) => void;
  onToast: (message: string) => void;
}) {
  const [capabilities, setCapabilities] = useState<DatasetCapabilities | null>(null);
  const [recommendations, setRecommendations] = useState<VisualizationRecommendation[]>([]);
  const [charts, setCharts] = useState<ChartEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<VisualizationConfig | null>(null);
  const [globalFilters, setGlobalFilters] = useState<FilterItem[]>([]);
  const [filterField, setFilterField] = useState('');
  const [filterOperator, setFilterOperator] = useState('eq');
  const [filterValue, setFilterValue] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reportTitle, setReportTitle] = useState('Untitled report');
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [reportId, setReportId] = useState('');
  const [reportSelection, setReportSelection] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [questionBusy, setQuestionBusy] = useState(false);
  const [undoStack, setUndoStack] = useState<ChartEntry[][]>([]);
  const [redoStack, setRedoStack] = useState<ChartEntry[][]>([]);

  const fields = capabilities?.columns ?? [];
  const numericFields = fields.filter((column) => column.kind === 'numeric' || column.kind === 'boolean');
  const dimensions = fields.filter((column) => ['categorical', 'boolean', 'date', 'identifier'].includes(column.kind));
  const chartsRef = useRef(charts);
  chartsRef.current = charts;
  const previousDatasetId = useRef(datasetId);
  const selectedFilterField = fields.some((field) => field.name === filterField) ? filterField : fields[0]?.name || '';

  const remember = useCallback((next: ChartEntry[]) => {
    setUndoStack((items) => [...items.slice(-19), charts]);
    setRedoStack([]);
    setCharts(next);
  }, [charts]);

  const loadChart = useCallback(async (config: VisualizationConfig, append = true) => {
    const id = config.id || makeId();
    const savedConfig = { ...config, id };
    if (append) {
      setCharts((items) => [...items, { config: savedConfig, busy: true }]);
      setSelectedId(id);
      setDraft(savedConfig);
    } else {
      setCharts((items) => items.map((item) => item.config.id === id ? { ...item, config: savedConfig, busy: true, error: undefined } : item));
    }
    setPanelOpen(false);
    try {
      const result = await api.aggregate(datasetId, {
        ...savedConfig,
        filters: [...savedConfig.filters, ...globalFilters],
      });
      setCharts((items) => items.map((item) => item.config.id === id ? { ...item, result, busy: false, error: undefined } : item));
      return { ...savedConfig, result };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Visualization could not be generated.';
      setCharts((items) => items.map((item) => item.config.id === id ? { ...item, busy: false, error: message } : item));
      if (append) setPanelOpen(true);
      return null;
    }
  }, [datasetId, globalFilters]);

  const refreshCharts = useCallback(async () => {
    setBusy(true);
    setError('');
    const current = [...charts];
    const outcomes = await Promise.all(current.map(async (chart) => {
      try {
        const result = await api.aggregate(datasetId, {
          ...chart.config,
          filters: [...chart.config.filters, ...globalFilters],
        });
        return { ...chart, result, busy: false, error: undefined };
      } catch (reason) {
        return { ...chart, busy: false, error: reason instanceof Error ? reason.message : 'Refresh failed.' };
      }
    }));
    setCharts(outcomes);
    setBusy(false);
    const failures = outcomes.filter((chart) => chart.error).length;
    onToast(failures ? `${failures} visualization(s) could not be refreshed.` : 'Visualizations refreshed from the selected dataset.');
  }, [charts, datasetId, globalFilters, onToast]);

  useEffect(() => {
    const datasetChanged = previousDatasetId.current !== datasetId;
    previousDatasetId.current = datasetId;
    if (datasetChanged) return;
    if (!chartsRef.current.length) return;
    const timer = window.setTimeout(() => {
      const latest = chartsRef.current;
      void Promise.all(latest.map(async (chart) => {
        try {
          const result = await api.aggregate(datasetId, {
            ...chart.config,
            filters: [...chart.config.filters, ...globalFilters],
          });
          return { ...chart, result, busy: false, error: undefined };
        } catch (reason) {
          return { ...chart, busy: false, error: reason instanceof Error ? reason.message : 'Filter query failed.' };
        }
      })).then(setCharts);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [datasetId, globalFilters]);

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    setBusy(true);
    setError('');
    setCapabilities(null);
    setCharts([]);
    setGlobalFilters([]);
    setReportId('');
    setSelectedId('');
    setDraft(null);
    Promise.all([api.capabilities(datasetId), api.recommendations(datasetId), api.reports()])
      .then(([nextCapabilities, nextRecommendations, nextReports]) => {
        if (!active) return;
        setCapabilities(nextCapabilities);
        setRecommendations(nextRecommendations.recommendations);
        setReports(nextReports);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load analytics schema.');
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [datasetId]);

  const addVisualization = (type: VisualizationType) => {
    if (!capabilities) return;
    const config = defaultConfig(type, capabilities);
    setDraft(config);
    setSelectedId(config.id ?? '');
    setPanelOpen(true);
  };

  const openEditor = (config: VisualizationConfig) => {
    setDraft({ ...config, filters: [...config.filters] });
    setSelectedId(config.id ?? '');
    setPanelOpen(true);
  };

  const updateDraft = (update: Partial<VisualizationConfig>) => {
    setDraft((current) => current ? { ...current, ...update } : current);
  };

  const applyDraft = async () => {
    if (!draft) return;
    const existing = charts.some((chart) => chart.config.id === draft.id);
    if (existing) {
      const snapshot = charts.map((chart) => chart.config.id === draft.id ? { ...chart, config: draft } : chart);
      remember(snapshot);
      await loadChart(draft, false);
    } else {
      setUndoStack((items) => [...items.slice(-19), charts]);
      setRedoStack([]);
      await loadChart(draft);
    }
  };

  const addRecommendation = (item: VisualizationRecommendation) => {
    if (!capabilities) return;
    setUndoStack((items) => [...items.slice(-19), charts]);
    setRedoStack([]);
    void loadChart({ ...item.config, id: makeId() });
  };

  const save = async () => {
    if (!datasetId) return;
    setBusy(true);
    try {
      const saved = await api.saveReport({
        id: reportId || undefined,
        title: reportTitle.trim() || 'Untitled report',
        dataset_id: datasetId,
        visualizations: charts.map((chart) => chart.config),
        filters: globalFilters,
      });
      setReportId(saved.id);
      setReportTitle(saved.title);
      setReports(await api.reports());
      onToast('Report saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Report save failed.');
    } finally {
      setBusy(false);
    }
  };

  const openReport = useCallback(async (id: string) => {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const report = await api.report(id);
      if (!report.dataset_available) throw new Error('The report references a dataset that is no longer available.');
      if (report.dataset_id !== datasetId) {
        onDatasetChange(report.dataset_id);
        setReportSelection(id);
        onToast('Report dataset selected. Open the report again after the schema loads.');
        return;
      }
      setReportId(report.id);
      setReportTitle(report.title);
      const reportFilters = (report as SavedReport & { filters?: FilterItem[] }).filters ?? [];
      setGlobalFilters(reportFilters);
      setCharts([]);
      for (const config of report.visualizations ?? []) {
        const saved = { ...config, id: config.id || makeId() };
        try {
          const result = await api.aggregate(report.dataset_id, {
            ...saved,
            filters: [...saved.filters, ...reportFilters],
          });
          setCharts((items) => [...items, { config: saved, result }]);
        } catch (reason) {
          setCharts((items) => [...items, { config: saved, error: reason instanceof Error ? reason.message : 'Could not restore chart.' }]);
        }
      }
      onToast(`Loaded ${report.title}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load report.');
    } finally {
      setBusy(false);
    }
  }, [datasetId, onDatasetChange, onToast]);

  useEffect(() => {
    if (reportSelection && datasetId === reports.find((report) => report.id === reportSelection)?.dataset_id && capabilities) {
      const selected = reportSelection;
      setReportSelection('');
      void openReport(selected);
    }
  }, [reportSelection, datasetId, reports, capabilities, openReport]);

  const duplicateChart = (chart: ChartEntry) => {
    const config = { ...chart.config, id: makeId(), title: `${chart.config.title} copy` };
    setUndoStack((items) => [...items.slice(-19), charts]);
    setRedoStack([]);
    void loadChart(config);
  };

  const deleteChart = (id: string) => {
    remember(charts.filter((chart) => chart.config.id !== id));
    if (selectedId === id) {
      setSelectedId('');
      setDraft(null);
      setPanelOpen(false);
    }
  };

  const reorderChart = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= charts.length) return;
    const next = [...charts];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    remember(next);
  };

  const ask = async (questionText = question) => {
    const text = questionText.trim();
    if (!text || !datasetId) return;
    setQuestionBusy(true);
    setAnswer('');
    try {
      const response = await api.askAnalytics(datasetId, text);
      if (response.kind === 'visualization' && response.config && response.visualization) {
        const config = { ...response.config, id: makeId() };
        remember([...charts, { config, result: response.visualization }]);
        setSelectedId(config.id ?? '');
        setDraft(config);
        setAnswer(`${response.explanation ?? 'Visualization generated.'} Analysis is rule-based; no LLM is configured.`);
      } else if (response.kind === 'recommendations' && Array.isArray(response.answer)) {
        setAnswer(`Found ${(response.answer as VisualizationRecommendation[]).length} schema-supported recommendations below.`);
      } else {
        setAnswer(typeof response.answer === 'string' ? response.answer : JSON.stringify(response.answer));
      }
    } catch (reason) {
      setAnswer(reason instanceof Error ? reason.message : 'Could not analyze this request.');
    } finally {
      setQuestionBusy(false);
      setQuestion('');
    }
  };

  const addGlobalFilter = () => {
    if (!selectedFilterField || (filterOperator !== 'is_null' && filterOperator !== 'not_null' && !filterValue.trim())) return;
    const kind = fieldKind(capabilities, selectedFilterField);
    const isRange = ['gt', 'gte', 'lt', 'lte'].includes(filterOperator);
    if (kind === 'numeric' && isRange && !Number.isFinite(Number(filterValue))) return;
    const value = kind === 'numeric' && isRange
      ? Number(filterValue)
      : filterValue;
    setGlobalFilters((items) => [...items, { field: selectedFilterField, operator: filterOperator, value }]);
    setFilterValue('');
  };

  const clearAnalysis = () => {
    remember([]);
    setGlobalFilters([]);
    setSelectedId('');
    setDraft(null);
    setReportId('');
    setReportTitle('Untitled report');
  };

  const undo = () => {
    if (!undoStack.length) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items, charts]);
    setCharts(previous);
  };
  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items, charts]);
    setCharts(next);
  };

  const exportReport = () => {
    const file = {
      title: reportTitle,
      dataset_id: datasetId,
      exported_at: new Date().toISOString(),
      filters: globalFilters,
      visualizations: charts.map((chart) => ({ config: chart.config, data: chart.result?.rows ?? [] })),
    };
    downloadFile(JSON.stringify(file, null, 2), `${safeFile(reportTitle)}.json`, 'application/json');
  };

  return <div className="space-y-5">
    <section className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[10px] text-slate-500">Active dataset<select aria-label="Analytics dataset" value={datasetId} onChange={(event) => onDatasetChange(event.target.value)} className="mt-1 block max-w-64 rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200">{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>
          <label className="text-[10px] text-slate-500">Report title<input aria-label="Report title" value={reportTitle} maxLength={160} onChange={(event) => setReportTitle(event.target.value)} className="mt-1 block w-48 rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200" /></label>
          {capabilities && <div className="pb-2 text-[10px] text-slate-500">{capabilities.shape.rows.toLocaleString()} rows · {capabilities.shape.columns} columns · {capabilities.roles.measures.length} measures · {capabilities.roles.dimensions.length} dimensions</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Load saved report" value="" onChange={(event) => void openReport(event.target.value)} className="max-w-40 rounded-lg border border-white/10 bg-[#111624] px-2 py-2 text-[10px] text-slate-300"><option value="">Load report…</option>{reports.map((report) => <option key={report.id} value={report.id}>{report.title}</option>)}</select>
          <button onClick={undo} disabled={!undoStack.length} title="Undo" className="rounded-lg border border-white/10 p-2 text-slate-300 disabled:opacity-40"><ArrowDown className="rotate-90" size={14} /></button>
          <button onClick={redo} disabled={!redoStack.length} title="Redo" className="rounded-lg border border-white/10 p-2 text-slate-300 disabled:opacity-40"><ArrowUp className="rotate-90" size={14} /></button>
          <button onClick={() => { if (capabilities) { setDraft(defaultConfig('bar', capabilities)); setSelectedId(''); setPanelOpen(true); } }} disabled={!capabilities} className="flex items-center gap-1 rounded-lg border border-sky-400/30 px-3 py-2 text-[10px] text-sky-300 disabled:opacity-40"><Plus size={13} />New visualization</button>
          <button onClick={() => addVisualization('kpi')} disabled={!capabilities} className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-[10px] text-slate-300 disabled:opacity-40"><Hash size={13} />Add KPI</button>
          <button onClick={() => void save()} disabled={busy || !capabilities} className="flex items-center gap-1 rounded-lg bg-sky-400 px-3 py-2 text-[10px] font-semibold text-[#07101b] disabled:opacity-40"><Save size={13} />Save report</button>
          <button onClick={exportReport} disabled={!charts.some((chart) => chart.result)} className="rounded-lg border border-white/10 p-2 text-slate-300 disabled:opacity-40" title="Export report data"><Download size={14} /></button>
          <button onClick={() => window.print()} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] text-slate-300">Print</button>
          <button onClick={() => void refreshCharts()} disabled={busy || !charts.length} title="Refresh data" className="rounded-lg border border-white/10 p-2 text-slate-300 disabled:opacity-40"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} /></button>
          <button onClick={clearAnalysis} disabled={!charts.length && !globalFilters.length} title="Clear analysis" className="rounded-lg border border-white/10 p-2 text-slate-400 disabled:opacity-40"><Trash2 size={14} /></button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{error}</p>}
      {!capabilities && !error && <p className="mt-4 flex items-center gap-2 text-xs text-slate-500"><LoaderCircle className="animate-spin" size={14} />Analyzing the selected dataset schema…</p>}
    </section>

    {capabilities && <section className="grid gap-4 xl:grid-cols-[1fr_270px]">
      <div className="space-y-4">
        <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white"><WandSparkles className="text-sky-300" size={16} />Ask AI to analyze</div>
          <form onSubmit={(event) => { event.preventDefault(); void ask(); }} className="flex flex-col gap-2 sm:flex-row">
            <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="e.g. Show stroke prevalence by age group" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#090d16] px-3 py-2.5 text-xs text-white outline-none focus:border-sky-400/50" />
            <button type="submit" disabled={questionBusy || !question.trim()} className="flex items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-2 text-xs font-semibold text-[#07101b] disabled:opacity-50"><Sparkles size={13} />{questionBusy ? 'Analyzing…' : 'Analyze'}</button>
          </form>
          <div className="mt-2 flex flex-wrap gap-2">{['Recommend useful charts', 'Show missing values', 'Create a donut chart'].map((sample) => <button key={sample} onClick={() => void ask(sample)} disabled={questionBusy} className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] text-slate-400 hover:border-sky-400/30 hover:text-sky-300">{sample}</button>)}</div>
          {answer && <p role="status" className="mt-3 rounded-lg bg-[#111624] p-3 text-xs leading-5 text-slate-300">{answer}</p>}
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4">
          <div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-medium text-white">Recommended analyses</h2><p className="mt-1 text-[10px] text-slate-500">Suggestions use fields detected in {capabilities.dataset.name}.</p></div><span className="rounded-full bg-sky-400/10 px-2 py-1 text-[10px] text-sky-300">{recommendations.length} available</span></div>
          {recommendations.length ? <div className="grid gap-2 md:grid-cols-2">{recommendations.slice(0, 6).map((item) => <button key={item.id} onClick={() => addRecommendation(item)} className="rounded-lg border border-white/[0.07] p-3 text-left transition hover:border-sky-400/30 hover:bg-sky-400/[0.03]"><span className="flex items-center gap-2 text-xs font-medium text-slate-200"><BarChart3 size={13} className="text-sky-300" />{item.question}</span><span className="mt-1 block text-[10px] text-slate-500">{item.reason}</span><span className="mt-2 block text-[9px] uppercase tracking-wide text-slate-600">{item.type} · {item.required_fields.join(', ') || 'all rows'}</span></button>)}</div> : <p className="py-3 text-xs text-slate-500">No field-based recommendations yet. A dataset record-count KPI is always available.</p>}
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-medium text-white">Report canvas</h2><p className="mt-1 text-[10px] text-slate-500">{charts.length} visualization{charts.length === 1 ? '' : 's'} · computed from actual rows</p></div>{charts.length > 0 && <span className="text-[10px] text-slate-600">Move cards with the arrows · toggle width to rearrange</span>}</div>
          {charts.length ? <div className="grid gap-3 md:grid-cols-2">{charts.map((chart, index) => <VisualizationCard key={chart.config.id} chart={chart} index={index} total={charts.length} selected={chart.config.id === selectedId} onEdit={() => openEditor(chart.config)} onDuplicate={() => duplicateChart(chart)} onDelete={() => deleteChart(chart.config.id ?? '')} onMove={(direction) => reorderChart(index, direction)} onWide={() => setCharts((items) => items.map((item) => item.config.id === chart.config.id ? { ...item, wide: !item.wide } : item))} onExport={() => chart.result && downloadCsv(chart.result.rows, chart.result.columns, `${safeFile(chart.config.title)}.csv`)} className={chart.wide ? 'md:col-span-2' : ''} />)}</div> : <div className="rounded-lg border border-dashed border-white/10 py-12 text-center"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300"><BarChart3 size={18} /></div><p className="mt-3 text-xs text-slate-300">Your report canvas is ready</p><p className="mt-1 text-[10px] text-slate-500">Choose a recommendation or add a visualization.</p><button onClick={() => addVisualization('bar')} className="mt-4 rounded-lg bg-sky-400 px-3 py-2 text-[10px] font-semibold text-[#07101b]">Create visualization</button></div>}
        </div>
      </div>

      <aside className="space-y-4">
        <section className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4">
          <div className="mb-3 flex items-center gap-2"><Filter size={14} className="text-sky-300" /><h2 className="text-xs font-medium text-white">Report filters</h2></div>
          <FilterEditor fields={filterFields(capabilities)} field={selectedFilterField} kind={fieldKind(capabilities, selectedFilterField)} onField={(value) => { setFilterField(value); setFilterOperator('eq'); }} operator={filterOperator} onOperator={setFilterOperator} value={filterValue} onValue={setFilterValue} onAdd={addGlobalFilter} />
          <div className="mt-3 space-y-2">{globalFilters.map((item, index) => <FilterChip key={`${item.field}-${index}`} filter={item} onRemove={() => setGlobalFilters((items) => items.filter((_, current) => current !== index))} />)}{globalFilters.length > 0 && <button onClick={() => setGlobalFilters([])} className="text-[10px] text-rose-300">Clear all report filters</button>}</div>
          <p className="mt-3 text-[9px] leading-4 text-slate-600">Report filters are applied to every visualization. Visual-specific filters remain local to each card.</p>
        </section>
        <section className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4">
          <div className="mb-3 flex items-center gap-2"><Search size={14} className="text-sky-300" /><h2 className="text-xs font-medium text-white">Dataset fields</h2></div>
          <div className="mb-2 flex flex-wrap gap-1">{['numeric', 'categorical', 'boolean', 'date', 'identifier'].map((kind) => <span key={kind} className="rounded bg-white/[0.04] px-1.5 py-1 text-[8px] text-slate-500">{kind}</span>)}</div>
          <div className="max-h-80 space-y-1 overflow-auto">{fields.map((field) => <button key={field.name} onClick={() => {
            const config = draft ?? defaultConfig('bar', capabilities);
            setDraft({ ...config, x_field: field.kind === 'numeric' ? config.x_field : field.name, y_field: field.kind === 'numeric' ? field.name : config.y_field });
            setSelectedId(config.id ?? '');
            setPanelOpen(true);
          }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/[0.04]"><span className="truncate text-[10px] text-slate-300">{field.name}</span><span className="shrink-0 rounded bg-sky-400/10 px-1.5 py-0.5 text-[8px] text-sky-300">{field.kind}</span></button>)}</div>
        </section>
      </aside>
    </section>}

    {panelOpen && draft && capabilities && <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanelOpen(false); }}>
      <section aria-label="Visualization configuration" className="h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-[#0b101b] p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between"><div><h2 className="text-lg font-semibold text-white">Configure visualization</h2><p className="mt-1 text-[10px] text-slate-500">Fields are validated against the active dataset schema.</p></div><button onClick={() => setPanelOpen(false)} aria-label="Close configuration" className="rounded-lg p-2 text-slate-500 hover:bg-white/5"><X size={17} /></button></div>
        <label className="mb-4 block text-[10px] text-slate-500">Title<input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} maxLength={120} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2.5 text-xs text-white" /></label>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Visualization type</h3>
        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{TYPE_OPTIONS.map(({ type, name, description, icon: Icon }) => <button key={type} onClick={() => {
          const initial = defaultConfig(type, capabilities);
          setDraft({
            ...initial,
            id: draft.id,
            title: draft.title,
            filters: draft.filters,
            palette: draft.palette,
            format: draft.format,
          });
        }} className={`rounded-lg border p-2 text-left ${draft.type === type ? 'border-sky-400/40 bg-sky-400/[0.06]' : 'border-white/[0.07] hover:border-white/20'}`}><Icon size={14} className={draft.type === type ? 'text-sky-300' : 'text-slate-500'} /><span className="mt-2 block text-[9px] font-medium text-slate-200">{name}</span><span className="mt-1 block text-[8px] leading-3 text-slate-600">{description}</span></button>)}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {draft.type !== 'kpi' && draft.type !== 'gauge' && draft.type !== 'correlation' && <>
            <FieldSelect label={draft.type === 'scatter' ? 'X-axis · numeric' : draft.type === 'histogram' ? 'Value field' : 'X-axis / category'} value={draft.x_field} options={draft.type === 'scatter' || draft.type === 'histogram' ? fields.filter((field) => field.kind === 'numeric') : dimensions.concat(fields.filter((field) => field.kind === 'numeric'))} onChange={(value) => updateDraft({ x_field: value })} />
          </>}
          {draft.type !== 'table' && draft.type !== 'pie' && draft.type !== 'donut' && draft.type !== 'correlation' && <>
            <FieldSelect label="Y-axis / measure" value={draft.y_field} options={draft.type === 'scatter' || ['box_plot'].includes(draft.type) ? numericFields.filter((field) => field.kind === 'numeric') : fields} onChange={(value) => {
              const options = aggregationOptions(value, capabilities);
              updateDraft({ y_field: value, aggregation: options.includes(draft.aggregation) ? draft.aggregation : 'count' });
            }} allowEmpty={draft.type === 'kpi' || draft.type === 'gauge'} />
          </>}
          {['grouped_bar', 'stacked_bar', 'line', 'area', 'heatmap'].includes(draft.type) && <FieldSelect label="Legend / series" value={draft.legend_field} options={dimensions} onChange={(value) => updateDraft({ legend_field: value || undefined })} allowEmpty />}
          {draft.type !== 'scatter' && draft.type !== 'table' && draft.type !== 'correlation' && <label className="text-[10px] text-slate-500">Aggregation<select value={draft.aggregation} onChange={(event) => updateDraft({ aggregation: event.target.value as VisualizationConfig['aggregation'] })} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200">{aggregationOptions(draft.y_field, capabilities).map((option) => <option key={option} value={option}>{option.replace('_', ' ')}</option>)}</select></label>}
          {draft.type !== 'scatter' && draft.type !== 'table' && draft.type !== 'correlation' && <label className="text-[10px] text-slate-500">Sort<select value={draft.sort ?? 'desc'} onChange={(event) => updateDraft({ sort: event.target.value as 'asc' | 'desc' })} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200"><option value="desc">Largest first</option><option value="asc">Smallest first</option></select></label>}
          {draft.type !== 'table' && draft.type !== 'scatter' && draft.type !== 'histogram' && draft.type !== 'kpi' && draft.type !== 'gauge' && draft.type !== 'correlation' && <label className="text-[10px] text-slate-500">Top categories<input type="number" min={1} max={100} value={draft.top_n ?? 15} onChange={(event) => updateDraft({ top_n: Number(event.target.value) })} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200" /></label>}
          {draft.type === 'histogram' && <label className="text-[10px] text-slate-500">Bins<input type="number" min={2} max={60} value={draft.bins ?? 20} onChange={(event) => updateDraft({ bins: Number(event.target.value) })} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200" /></label>}
          {draft.type === 'correlation' && <label className="text-[10px] text-slate-500 sm:col-span-2">Numeric fields<select multiple value={draft.fields ?? []} onChange={(event) => updateDraft({ fields: Array.from(event.target.selectedOptions, (option) => option.value) })} className="mt-1 block h-28 w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200">{fields.filter((field) => field.kind === 'numeric').map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}</select><span className="mt-1 block text-[9px] text-slate-600">Select 2–12 numerical fields.</span></label>}
          {draft.type === 'table' && <label className="text-[10px] text-slate-500 sm:col-span-2">Columns<select multiple value={draft.fields ?? fields.slice(0, 8).map((field) => field.name)} onChange={(event) => updateDraft({ fields: Array.from(event.target.selectedOptions, (option) => option.value) })} className="mt-1 block h-28 w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200">{fields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}</select></label>}
          {draft.type !== 'correlation' && <FieldSelect label="Number format" value={draft.format ?? 'number'} options={['number', 'currency', 'percent'].map((name) => ({ name, kind: name }))} onChange={(value) => updateDraft({ format: value as VisualizationConfig['format'] })} />}
          <FieldSelect label="Color palette" value={draft.palette ?? 'cyan'} options={['cyan', 'emerald', 'violet'].map((name) => ({ name, kind: 'palette' }))} onChange={(value) => updateDraft({ palette: value as VisualizationConfig['palette'] })} />
        </div>
        <div className="mt-5 rounded-xl border border-white/[0.07] p-3"><h3 className="mb-3 text-xs font-medium text-white">Visual filters</h3><FilterEditor fields={filterFields(capabilities)} field={selectedFilterField} kind={fieldKind(capabilities, selectedFilterField)} onField={(value) => { setFilterField(value); setFilterOperator('eq'); }} operator={filterOperator} onOperator={setFilterOperator} value={filterValue} onValue={setFilterValue} onAdd={() => {
          if (!selectedFilterField || (filterOperator !== 'is_null' && filterOperator !== 'not_null' && !filterValue.trim())) return;
          const kind = fieldKind(capabilities, selectedFilterField);
          const isRange = ['gt', 'gte', 'lt', 'lte'].includes(filterOperator);
          if (kind === 'numeric' && isRange && !Number.isFinite(Number(filterValue))) return;
          const value = kind === 'numeric' && isRange ? Number(filterValue) : filterValue;
          updateDraft({ filters: [...draft.filters, { field: selectedFilterField, operator: filterOperator, value }] });
          setFilterValue('');
        }} /><div className="mt-3 space-y-2">{draft.filters.map((filter, index) => <FilterChip key={`${filter.field}-${index}`} filter={filter} onRemove={() => updateDraft({ filters: draft.filters.filter((_, current) => current !== index) })} />)}{draft.filters.length > 0 && <button onClick={() => updateDraft({ filters: [] })} className="text-[10px] text-rose-300">Clear visual filters</button>}</div></div>
        <div className="mt-5 rounded-lg border border-sky-400/10 bg-sky-400/[0.03] p-3 text-[10px] leading-5 text-slate-500">Count and distinct count accept categorical or numeric fields. Sum, average, minimum, maximum, and median require a numeric field. Identifiers are excluded from measures.</div>
        <button onClick={() => void applyDraft()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-3 text-xs font-semibold text-[#07101b]"><Check size={14} />Generate visualization</button>
      </section>
    </div>}
  </div>;
}

function aggregationOptions(field: string | undefined, capabilities: DatasetCapabilities) {
  if (!field) return ['count'];
  return fieldKind(capabilities, field) === 'numeric' ? ['count', 'distinct_count', 'sum', 'avg', 'min', 'max', 'median'] : ['count', 'distinct_count'];
}

function FieldSelect({
  label, value, options, onChange, allowEmpty = false,
}: {
  label: string;
  value?: string;
  options: Array<{ name: string; kind: string }>;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}) {
  return <label className="text-[10px] text-slate-500">{label}<select value={value ?? ''} onChange={(event) => onChange(event.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200"><option value="">{allowEmpty ? 'No field (row count)' : 'Select field'}</option>{options.map((option) => <option key={option.name} value={option.name}>{option.name} · {option.kind}</option>)}</select></label>;
}

function FilterEditor({
  fields, field, kind, onField, operator, onOperator, value, onValue, onAdd,
}: {
  fields: string[];
  field: string;
  kind?: string;
  onField: (value: string) => void;
  operator: string;
  onOperator: (value: string) => void;
  value: string;
  onValue: (value: string) => void;
  onAdd: () => void;
}) {
  const operators = FILTER_OPERATORS.filter(([name]) =>
    (!['gte', 'lte'].includes(name) || kind === 'numeric' || kind === 'date')
    && (name !== 'contains' || kind === 'categorical' || kind === 'identifier'),
  );
  return <div className="space-y-2">
    <select aria-label="Filter field" value={field || fields[0] || ''} onChange={(event) => onField(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#111624] px-2 py-2 text-[10px] text-slate-300">{fields.map((name) => <option key={name} value={name}>{name}</option>)}</select>
    <div className="flex gap-2"><select aria-label="Filter operator" value={operator} onChange={(event) => onOperator(event.target.value)} className="min-w-24 rounded-lg border border-white/10 bg-[#111624] px-2 py-2 text-[10px] text-slate-300">{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{!['is_null', 'not_null'].includes(operator) && <input aria-label="Filter value" type={kind === 'numeric' && ['gte', 'lte'].includes(operator) ? 'number' : kind === 'date' && ['gte', 'lte'].includes(operator) ? 'date' : 'text'} value={value} onChange={(event) => onValue(event.target.value)} placeholder="Value" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111624] px-2 py-2 text-[10px] text-white" />}</div>
    <button onClick={onAdd} disabled={!field || (operator !== 'is_null' && operator !== 'not_null' && !value.trim())} className="flex w-full items-center justify-center gap-1 rounded-lg border border-sky-400/20 px-2 py-2 text-[10px] text-sky-300 disabled:opacity-40"><Plus size={12} />Add filter</button>
  </div>;
}

function FilterChip({ filter, onRemove }: { filter: FilterItem; onRemove: () => void }) {
  const symbol = FILTER_OPERATORS.find(([operator]) => operator === filter.operator)?.[1] ?? filter.operator;
  return <div className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5"><span className="truncate text-[9px] text-slate-400">{filter.field} {symbol}{filter.value !== undefined ? ` ${String(filter.value)}` : ''}</span><button onClick={onRemove} aria-label={`Remove ${filter.field} filter`} className="text-slate-600 hover:text-rose-300"><X size={12} /></button></div>;
}

function VisualizationCard({
  chart, index, total, selected, onEdit, onDuplicate, onDelete, onMove, onWide, onExport, className,
}: {
  chart: ChartEntry;
  index: number;
  total: number;
  selected: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onWide: () => void;
  onExport: () => void;
  className: string;
}) {
  return <article className={`min-w-0 rounded-xl border bg-[#0b111d] p-3 ${selected ? 'border-sky-400/40' : 'border-white/[0.07]'} ${className}`}>
    <div className="mb-3 flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-xs font-medium text-white">{chart.config.title}</h3><p className="mt-1 truncate text-[9px] text-slate-600">{chart.config.type.replace('_', ' ')}{chart.config.x_field ? ` · ${chart.config.x_field}` : ''}{chart.config.y_field ? ` · ${chart.config.aggregation} ${chart.config.y_field}` : ` · ${chart.config.aggregation}`}</p></div><div className="flex shrink-0 items-center gap-1"><button onClick={() => onMove(-1)} disabled={index === 0} title="Move earlier" className="p-1 text-slate-500 disabled:opacity-20"><ArrowUp size={12} /></button><button onClick={() => onMove(1)} disabled={index === total - 1} title="Move later" className="p-1 text-slate-500 disabled:opacity-20"><ArrowDown size={12} /></button><button onClick={onWide} title="Resize card" className="p-1 text-slate-500"><Grid2X2 size={12} /></button><button onClick={onEdit} title="Edit visualization" className="p-1 text-sky-300"><Activity size={12} /></button><button onClick={onDuplicate} title="Duplicate visualization" className="p-1 text-slate-400"><Copy size={12} /></button><button onClick={onExport} disabled={!chart.result} title="Export chart data" className="p-1 text-slate-400 disabled:opacity-30"><Download size={12} /></button><button onClick={onDelete} title="Delete visualization" className="p-1 text-rose-300"><Trash2 size={12} /></button></div></div>
    {chart.busy ? <div className="flex h-48 items-center justify-center gap-2 text-xs text-slate-500"><LoaderCircle className="animate-spin" size={14} />Calculating from dataset…</div> : chart.error ? <div role="alert" className="flex h-48 items-center justify-center rounded-lg bg-rose-400/[0.04] p-4 text-center text-xs text-rose-200">{chart.error}</div> : chart.result ? <ChartRenderer result={chart.result} /> : <div className="flex h-48 items-center justify-center text-xs text-slate-500">Configure and generate to calculate this visualization.</div>}
    {chart.result && <details className="mt-3 border-t border-white/[0.06] pt-2"><summary className="cursor-pointer text-[9px] text-slate-500">Inspect underlying data · {chart.result.row_count} rows</summary><DataPreview result={chart.result} /></details>}
  </article>;
}

function ChartRenderer({ result }: { result: AggregateResult }) {
  const type = result.config.type;
  const rows = result.rows;
  if (!rows.length) return <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-white/[0.08] text-xs text-slate-500">No rows match the current filters.</div>;
  if (type === 'table') return <DataPreview result={result} />;
  if (type === 'correlation') return <CorrelationChart result={result} />;
  if (type === 'scatter') return <ScatterChartView result={result} />;
  if (type === 'box_plot') return <BoxPlot result={result} />;
  if (type === 'kpi' || type === 'gauge') return <KPIChart result={result} />;
  if (type === 'pie' || type === 'donut') return <PieChartView result={result} donut={type === 'donut'} />;
  if (type === 'line' || type === 'area') return <LineChartView result={result} area={type === 'area'} />;
  if (type === 'heatmap') return <Heatmap result={result} />;
  return <BarChartView result={result} horizontal={type === 'horizontal_bar'} />;
}

function BarChartView({ result, horizontal }: { result: AggregateResult; horizontal: boolean }) {
  const rows = result.rows;
  const values = rows.map((row) => Number(row.value) || 0);
  const maxValue = Math.max(...values, 0);
  const palette = PALETTES[result.config.palette ?? 'cyan'];
  if (horizontal) return <div className="max-h-64 space-y-2 overflow-auto py-2">{rows.map((row, index) => <div key={index} className="grid grid-cols-[minmax(60px,110px)_1fr_56px] items-center gap-2 text-[9px]"><span className="truncate text-slate-400">{String(row.category ?? '(blank)')}</span><div className="h-3 overflow-hidden rounded bg-white/[0.04]"><div className="h-full rounded" style={{ width: `${Number(row.value) / (maxValue || 1) * 100}%`, background: palette[index % palette.length] }} /></div><span className="text-right text-slate-300">{formatValue(row.value, result.config.format)}</span></div>)}</div>;
  const series = Array.from(new Set(rows.map((row) => String(row.series ?? '')))).filter(Boolean);
  const categories = Array.from(new Set(rows.map((row) => String(row.category ?? '(blank)'))));
  return <div className="flex h-56 items-end gap-1 overflow-x-auto border-b border-white/[0.08] px-1 pb-1">
    {categories.map((category, categoryIndex) => {
      const group = rows.filter((row) => String(row.category ?? '(blank)') === category);
      const stacked = result.config.type === 'stacked_bar';
      return <div key={`${category}-${categoryIndex}`} title={group.map((row) => `${row.series ?? category}: ${formatValue(row.value, result.config.format)}`).join(' · ')} className="group flex h-full min-w-5 flex-1 items-end justify-center gap-px">
        {series.length && result.config.type === 'grouped_bar' ? series.map((name, seriesIndex) => {
          const item = group.find((row) => row.series === name);
          return <div key={name} className="w-full rounded-t-sm" style={{ height: `${(Number(item?.value) || 0) / (maxValue || 1) * 100}%`, background: palette[seriesIndex % palette.length] }} />;
        }) : stacked ? <div className="flex w-full flex-col-reverse">{group.map((row, index) => <div key={index} className="w-full" style={{ height: `${(Number(row.value) || 0) / (maxValue || 1) * 100}%`, background: palette[index % palette.length] }} />)}</div> : <div className="w-full max-w-10 rounded-t-sm transition-opacity group-hover:opacity-80" style={{ height: `${(Number(group[0]?.value) || 0) / (maxValue || 1) * 100}%`, background: palette[categoryIndex % palette.length] }} />}
      </div>;
    })}
  </div>;
}

function LineChartView({ result, area }: { result: AggregateResult; area: boolean }) {
  const values = result.rows.map((row) => Number(row.value) || 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const width = Math.max(values.length * 24, 240);
  const height = 170;
  const points = values.map((value, index) => `${values.length === 1 ? width / 2 : index / (values.length - 1) * width},${height - 12 - ((value - min) / (max - min || 1)) * (height - 24)}`).join(' ');
  return <div className="overflow-x-auto"><svg viewBox={`0 0 ${width} ${height}`} className="h-52 min-w-full" role="img" aria-label={result.config.title}>{area && <polygon points={`0,${height} ${points} ${width},${height}`} fill="#38bdf833" />}{result.rows.length > 1 && <polyline points={points} fill="none" stroke="#38bdf8" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}{result.rows.map((row, index) => { const [cx, cy] = points.split(' ')[index].split(',').map(Number); return <g key={index}><circle cx={cx} cy={cy} r="4" fill="#38bdf8"><title>{`${String(row.category)}: ${formatValue(row.value, result.config.format)}`}</title></circle></g>; })}</svg><div className="flex justify-between text-[9px] text-slate-600"><span>{String(result.rows[0].category)}</span><span>{String(result.rows[result.rows.length - 1].category)}</span></div></div>;
}

function PieChartView({ result, donut }: { result: AggregateResult; donut: boolean }) {
  const rows = result.rows.slice(0, 12);
  const total = rows.reduce((sum, row) => sum + Math.max(Number(row.value) || 0, 0), 0) || 1;
  const palette = PALETTES[result.config.palette ?? 'cyan'];
  let cumulative = 0;
  const paths = rows.map((row, index) => {
    const start = cumulative / total * Math.PI * 2 - Math.PI / 2;
    cumulative += Math.max(Number(row.value) || 0, 0);
    const end = cumulative / total * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const point = (angle: number, radius: number) => [100 + Math.cos(angle) * radius, 100 + Math.sin(angle) * radius];
    const [x1, y1] = point(start, 76);
    const [x2, y2] = point(end, 76);
    const [ix1, iy1] = point(end, donut ? 42 : 0);
    const [ix2, iy2] = point(start, donut ? 42 : 0);
    return { d: `M ${x1} ${y1} A 76 76 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1}${donut ? ` A 42 42 0 ${large} 0 ${ix2} ${iy2}` : ''} Z`, color: palette[index % palette.length], name: String(row.category), value: row.value };
  });
  return <div className="flex h-56 items-center justify-center gap-4"><svg viewBox="0 0 200 200" className="h-48 w-48 shrink-0">{paths.map((path, index) => <path key={index} d={path.d} fill={path.color} stroke="#0b111d" strokeWidth="1"><title>{`${path.name}: ${formatValue(path.value, result.config.format)}`}</title></path>)}{donut && <text x="100" y="104" textAnchor="middle" fill="#e2e8f0" fontSize="12">{total.toLocaleString()}</text>}</svg><div className="max-h-48 space-y-2 overflow-auto">{paths.map((path) => <div key={path.name} className="flex items-center gap-2 text-[9px]"><span className="h-2 w-2 rounded-sm" style={{ background: path.color }} /><span className="max-w-24 truncate text-slate-400">{path.name}</span><span className="text-slate-200">{formatValue(path.value, result.config.format)}</span></div>)}</div></div>;
}

function ScatterChartView({ result }: { result: AggregateResult }) {
  const rows = result.rows;
  const xs = rows.map((row) => Number(row.x));
  const ys = rows.map((row) => Number(row.y));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = 320, height = 180;
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full" role="img" aria-label={result.config.title}><path d={`M 24 8 V ${height - 24} H ${width - 8}`} fill="none" stroke="#334155" />{rows.map((row, index) => { const x = 24 + ((Number(row.x) - minX) / (maxX - minX || 1)) * (width - 40); const y = height - 24 - ((Number(row.y) - minY) / (maxY - minY || 1)) * (height - 40); return <circle key={index} cx={x} cy={y} r="3" fill={PALETTES[result.config.palette ?? 'cyan'][index % 6]} opacity=".8"><title>{`${result.config.x_field}: ${row.x}; ${result.config.y_field}: ${row.y}`}</title></circle>; })}<text x={width / 2} y={height - 3} textAnchor="middle" fill="#64748b" fontSize="9">{result.config.x_field}</text><text x="5" y="12" fill="#64748b" fontSize="9">{result.config.y_field}</text></svg>;
}

function BoxPlot({ result }: { result: AggregateResult }) {
  const rows = result.rows;
  const min = Math.min(...rows.map((row) => Number(row.min)));
  const max = Math.max(...rows.map((row) => Number(row.max)));
  const scale = (value: unknown) => ((Number(value) - min) / (max - min || 1)) * 90 + 5;
  return <div className="max-h-60 space-y-3 overflow-auto py-3">{rows.map((row, index) => <div key={index} className="grid grid-cols-[80px_1fr] items-center gap-2 text-[9px]"><span className="truncate text-slate-400">{String(row.category ?? '')}</span><div className="relative h-6"><div className="absolute top-3 h-px bg-slate-500" style={{ left: `${scale(row.min)}%`, width: `${scale(row.max) - scale(row.min)}%` }} /><div className="absolute top-1 h-5 border border-sky-300 bg-sky-400/20" style={{ left: `${scale(row.q1)}%`, width: `${Math.max(scale(row.q3) - scale(row.q1), 1)}%` }} /><div className="absolute top-1 h-5 border-l-2 border-white" style={{ left: `${scale(row.median)}%` }} /></div></div>)}</div>;
}

function KPIChart({ result }: { result: AggregateResult }) {
  const value = result.rows[0]?.value;
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : null;
  const maximum = Number(result.config.y_field && result.config.type === 'gauge' ? 100 : 100);
  return <div className="flex h-56 flex-col items-center justify-center"><div className="relative flex h-36 w-36 items-center justify-center rounded-full border-[10px] border-sky-400/50" style={result.config.type === 'gauge' && normalized !== null ? { background: `conic-gradient(#38bdf8 ${Math.min(Math.max(normalized / maximum * 100, 0), 100)}%, #172033 0)` } : undefined}><div className="flex h-28 w-28 items-center justify-center rounded-full bg-[#0b111d] px-2 text-center text-2xl font-semibold text-white">{formatValue(value, result.config.format)}</div></div><p className="mt-3 text-[10px] text-slate-500">{result.config.aggregation.replace('_', ' ')} {result.config.y_field ?? 'records'}</p></div>;
}

function Heatmap({ result }: { result: AggregateResult }) {
  const values = result.rows.map((row) => Number(row.value) || 0);
  const maximum = Math.max(...values, 1);
  return <div className="grid max-h-60 grid-cols-2 gap-2 overflow-auto p-2 sm:grid-cols-3">{result.rows.map((row, index) => <div key={index} title={`${row.category}${row.series ? ` / ${row.series}` : ''}: ${row.value}`} className="flex h-14 flex-col justify-between rounded-lg p-2" style={{ background: `rgba(56, 189, 248, ${0.08 + (Number(row.value) || 0) / maximum * 0.65})` }}><span className="truncate text-[9px] text-white">{String(row.category)}{row.series ? ` · ${String(row.series)}` : ''}</span><span className="text-right text-[10px] text-white">{formatValue(row.value, result.config.format)}</span></div>)}</div>;
}

function CorrelationChart({ result }: { result: AggregateResult }) {
  const fields = result.columns;
  return <div className="max-h-60 overflow-auto"><table className="w-full border-collapse text-center text-[9px]"><thead><tr><th className="p-1" />{fields.map((field) => <th key={field} className="max-w-16 truncate p-1 text-slate-500">{field}</th>)}</tr></thead><tbody>{result.rows.map((row) => <tr key={String(row.field)}><th className="max-w-16 truncate p-1 text-left text-slate-400">{String(row.field)}</th>{(row.values as Array<number | null>).map((value, index) => <td key={index} title={value === null ? 'Insufficient variation or data' : String(value)} className="min-w-8 rounded p-1 text-white" style={{ background: value === null ? '#172033' : `rgba(${value < 0 ? '251, 113, 133' : '56, 189, 248'}, ${Math.max(Math.abs(value), 0.08)})` }}>{value === null ? '—' : value.toFixed(2)}</td>)}</tr>)}</tbody></table><p className="mt-2 text-[9px] text-slate-600">Pearson correlation; pairwise nulls excluded. Correlation does not imply causation.</p></div>;
}

function DataPreview({ result }: { result: AggregateResult }) {
  if (!result.rows.length) return <p className="p-4 text-center text-[10px] text-slate-500">No rows.</p>;
  return <div className="max-h-56 overflow-auto"><table className="w-full min-w-max text-left text-[9px]"><thead className="sticky top-0 bg-[#101725] text-slate-500"><tr>{result.columns.map((column) => <th key={column} className="px-2 py-1.5">{column}</th>)}</tr></thead><tbody>{result.rows.slice(0, 100).map((row, index) => <tr key={index} className="border-t border-white/[0.05]">{result.columns.map((column) => <td key={column} className="max-w-48 truncate px-2 py-1.5 text-slate-300">{row[column] === null || row[column] === undefined ? 'NULL' : String(row[column])}</td>)}</tr>)}</tbody></table></div>;
}

function formatValue(value: unknown, format?: VisualizationConfig['format']) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '—');
  if (format === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number);
  if (format === 'percent') return `${(number * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number);
}

function safeFile(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
}

function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(rows: Array<Record<string, unknown>>, columns: string[], filename: string) {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [columns.map(escape).join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\r\n');
  downloadFile(csv, filename, 'text/csv;charset=utf-8');
}
