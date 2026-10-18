import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Check, ChevronDown,
  ChevronRight, CircleHelp, Database, Download, LayoutDashboard,
  LoaderCircle, MessageSquareText, Play, RefreshCw, Search, Send, Settings2,
  Sparkles, Table2, TerminalSquare, Upload, WandSparkles, X,
} from 'lucide-react';
import { api, type ChatResponse, type Dataset, type DatasetDetail, type MetricResponse, type QualityReport, type QueryResult } from './api';
import AnalyticsStudio from './AnalyticsStudio';
import DatasetEditor from './DatasetEditor';

type View = 'Overview' | 'Datasets' | 'SQL workspace' | 'Data quality' | 'Analytics' | 'Settings';
type ChatItem = { role: 'user' | 'assistant'; text: string; evidence?: ChatResponse };
const NAV: Array<{ label: View; icon: typeof LayoutDashboard }> = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Datasets', icon: Table2 },
  { label: 'SQL workspace', icon: TerminalSquare },
  { label: 'Data quality', icon: Activity },
  { label: 'Analytics', icon: BarChart3 },
  { label: 'Settings', icon: Settings2 },
];
const daysForPeriod: Record<string, number> = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 };

function localDate(date: Date): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const result = new Date();
  result.setDate(result.getDate() - days);
  return localDate(result);
}

function App() {
  const [view, setView] = useState<View>('Overview');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [datasetRevision, setDatasetRevision] = useState(0);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [metrics, setMetrics] = useState<MetricResponse | null>(null);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [period, setPeriod] = useState('Last 30 days');
  const [customStart, setCustomStart] = useState(daysAgo(29));
  const [customEnd, setCustomEnd] = useState(localDate(new Date()));
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMatches, setSearchMatches] = useState<Array<Record<string, unknown>>>([]);
  const [searchError, setSearchError] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [sql, setSql] = useState('');
  const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlError, setSqlError] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  const dateRange = useMemo(() => {
    if (period !== 'Custom range') return { days: daysForPeriod[period] ?? 30 };
    const [startYear, startMonth, startDay] = customStart.split('-').map(Number);
    const [endYear, endMonth, endDay] = customEnd.split('-').map(Number);
    const start = Date.UTC(startYear, startMonth - 1, startDay);
    const end = Date.UTC(endYear, endMonth - 1, endDay);
    const days = Math.floor((end - start) / 86_400_000) + 1;
    return { days, start: customStart, end: customEnd };
  }, [period, customStart, customEnd]);
  const activeDataset = datasets.find((dataset) => dataset.id === datasetId);
  const dateRangeValid = Number.isInteger(dateRange.days) && dateRange.days >= 1 && dateRange.days <= 366;
  const filteredDatasets = datasets.filter((dataset) => dataset.name.toLowerCase().includes(searchText.toLowerCase()));

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2800);
  };

  const loadDatasets = useCallback(async (chooseFirst = false) => {
    setError('');
    try {
      const result = await api.datasets();
      setDatasets(result);
      if (chooseFirst && result.length) setDatasetId(result[0].id);
      if (datasetId && !result.some((dataset) => dataset.id === datasetId)) {
        setDatasetId(result[0]?.id ?? '');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not connect to the analytics API.');
    }
  }, [datasetId]);

  const refresh = useCallback(async () => {
    if (!datasetId) {
      await loadDatasets(true);
      return;
    }
    if (!Number.isInteger(dateRange.days) || dateRange.days < 1 || dateRange.days > 366) {
      setError('Choose a valid date range of no more than 366 days.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [nextDatasets, nextMetrics, nextDetail, nextQuality] = await Promise.all([
        api.datasets(),
        api.metrics(datasetId, dateRange.days, dateRange.start, dateRange.end),
        api.detail(datasetId),
        api.quality(datasetId),
      ]);
      setDatasets(nextDatasets);
      setMetrics(nextMetrics);
      setDetail(nextDetail);
      setQuality(nextQuality);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Refresh failed.');
    } finally {
      setLoading(false);
    }
  }, [datasetId, dateRange, loadDatasets]);

  useEffect(() => {
    void api.datasets().then((result) => {
      setDatasets(result);
      if (result.length) setDatasetId((current) => current || result[0].id);
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not connect to the analytics API.');
    });
  }, []);

  useEffect(() => {
    if (!datasetId) return;
    void refresh();
  }, [datasetId, datasetRevision, refresh]);

  useEffect(() => {
    const term = searchText.trim();
    if (!datasetId || !term) {
      setSearchMatches([]);
      setSearchError('');
      return;
    }
    const timer = window.setTimeout(() => {
      void api.search(datasetId, term).then((result) => {
        setSearchMatches(result.matches);
        setSearchError('');
      }).catch((reason: unknown) => {
        setSearchMatches([]);
        setSearchError(reason instanceof Error ? reason.message : 'Search failed.');
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [datasetId, searchText]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (datasetId) {
      setSql(`SELECT * FROM dataset_${datasetId.replace(/-/g, '')} LIMIT 20;`);
      setSqlResult(null);
      setSqlError('');
      void api.sqlHistory(datasetId).then((entries) => {
        setHistory(entries.map((entry) => entry.query));
      }).catch((reason: unknown) => {
        setSqlError(reason instanceof Error ? reason.message : 'Could not load SQL history.');
      });
    }
  }, [datasetId]);

  const uploadFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const uploaded = await api.upload(file);
      const next = await api.datasets();
      setDatasets(next);
      setDatasetId(uploaded.id);
      setView('Datasets');
      showToast(`Imported ${uploaded.name}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const runSql = async () => {
    if (!datasetId) return;
    setSqlBusy(true);
    setSqlError('');
    try {
      const result = await api.execute(datasetId, sql);
      setSqlResult(result);
      const entries = await api.sqlHistory(datasetId);
      setHistory(entries.map((entry) => entry.query));
    } catch (reason) {
      setSqlResult(null);
      setSqlError(reason instanceof Error ? reason.message : 'Query failed.');
    } finally {
      setSqlBusy(false);
    }
  };

  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || !datasetId || chatBusy) return;
    setChat((items) => [...items, { role: 'user', text: message }]);
    setChatInput('');
    setChatBusy(true);
    try {
      const response = await api.ask(datasetId, message);
      setChat((items) => [...items, { role: 'assistant', text: response.answer, evidence: response }]);
    } catch (reason) {
      setChat((items) => [...items, { role: 'assistant', text: `Analysis failed: ${reason instanceof Error ? reason.message : 'unknown error'}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  const exportMetrics = () => {
    if (!datasetId) return;
    const params = new URLSearchParams({ dataset_id: datasetId, days: String(dateRange.days) });
    if (dateRange.start && dateRange.end) {
      params.set('start_date', dateRange.start);
      params.set('end_date', dateRange.end);
    }
    window.location.assign(`/api/exports/metrics?${params}`);
  };

  const selectPeriod = (value: string) => {
    setPeriod(value);
    if (value === 'Custom range') {
      setCustomEnd(localDate(new Date()));
      setCustomStart(daysAgo(29));
    }
  };

  return (
    <div className="min-h-screen bg-[#080b13] text-slate-200 selection:bg-sky-400/30">
      <div className="flex min-h-screen">
        <aside className="hidden w-[74px] shrink-0 flex-col items-center border-r border-white/[0.07] bg-[#0b0f1a] py-5 md:flex">
          <div className="mb-10 flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400 text-[#07101b] shadow-[0_0_26px_rgba(56,189,248,0.3)]"><Database size={20} strokeWidth={2.5} /></div>
          <nav className="flex flex-1 flex-col items-center gap-3" aria-label="Primary navigation">
            {NAV.map(({ label, icon }) => <SideIcon key={label} icon={icon} label={label} active={view === label} onClick={() => setView(label)} />)}
          </nav>
          <div className="flex flex-col items-center gap-5 text-slate-500"><button onClick={() => showToast('Use the dataset selector to choose an active table.')} aria-label="Help"><CircleHelp size={18} /></button><div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-[11px] font-semibold text-sky-300">DP</div></div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex min-h-[72px] items-center justify-between gap-4 border-b border-white/[0.07] bg-[#080b13]/95 px-5 backdrop-blur md:px-8">
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2 text-sm text-slate-500 sm:flex"><span>Workspace</span><ChevronRight size={14} /><span className="text-slate-300">{view}</span></div>
              <div className="flex items-center gap-2 text-sm font-medium text-white"><span className={`h-2 w-2 rounded-full ${error ? 'bg-rose-400' : 'bg-emerald-400'}`} />{activeDataset?.name ?? 'DataPilot workspace'}</div>
            </div>
            <div className="flex items-center gap-2 md:gap-4">
              <div className="relative hidden lg:block">
                <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-slate-400"><Search size={14} /><input ref={searchRef} value={searchText} onFocus={() => setSearchOpen(true)} onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)} onChange={(event) => setSearchText(event.target.value)} placeholder="Search datasets" className="w-32 bg-transparent text-xs text-white outline-none placeholder:text-slate-500" /><kbd className="rounded border border-white/10 px-1.5 py-0.5 text-[10px]">Ctrl K</kbd></div>
                {searchOpen && searchText && <div className="absolute right-0 top-12 z-30 max-h-96 w-80 overflow-auto rounded-xl border border-white/10 bg-[#101725] p-2 shadow-xl"><p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Datasets</p>{filteredDatasets.map((dataset) => <button key={dataset.id} onMouseDown={() => { setDatasetId(dataset.id); setView('Datasets'); }} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/[0.06]">{dataset.name}<span className="mt-1 block text-[10px] text-slate-500">{dataset.row_count} rows · {dataset.column_count} columns</span></button>)}{detail?.columns.some((column) => column.name.toLowerCase().includes(searchText.toLowerCase())) && <><p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Columns</p>{detail.columns.filter((column) => column.name.toLowerCase().includes(searchText.toLowerCase())).map((column) => <button key={column.name} onMouseDown={() => setView('Datasets')} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/[0.06]">{column.name}<span className="ml-2 text-[10px] text-slate-500">{column.type}</span></button>)}</>}{searchError && <p className="px-3 py-2 text-xs text-rose-300">{searchError}</p>}{searchMatches.length > 0 && <><p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Matching records</p>{searchMatches.slice(0, 4).map((row, index) => <button key={index} onMouseDown={() => setView('Datasets')} className="block w-full truncate rounded-lg px-3 py-2 text-left text-[10px] text-slate-300 hover:bg-white/[0.06]">{Object.values(row).join(' · ')}</button>)}</>}{!filteredDatasets.length && !searchMatches.length && !searchError && <p className="px-3 py-2 text-xs text-slate-500">No matching datasets or records.</p>}</div>}
              </div>
              <div className="relative"><button onClick={() => setNotificationsOpen((open) => !open)} className="rounded-lg p-2 text-slate-400 hover:bg-white/[0.05] hover:text-white" aria-label="Notifications"><Bell size={17} /></button>{notificationsOpen && <div className="absolute right-0 top-11 z-30 w-64 rounded-xl border border-white/10 bg-[#101725] p-4 text-xs text-slate-400 shadow-xl"><p className="font-medium text-white">Workspace activity</p><p className="mt-2">{activeDataset ? `Active dataset: ${activeDataset.name}. No new alerts.` : 'No datasets have been loaded yet.'}</p></div>}</div>
              <button onClick={() => void refresh()} disabled={loading} className="hidden items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-sky-400/30 hover:bg-sky-400/5 disabled:opacity-50 sm:flex"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button>
              <button onClick={() => setChatOpen((open) => !open)} className="flex items-center gap-2 rounded-lg bg-sky-400 px-3 py-2 text-xs font-semibold text-[#07101b] transition hover:bg-sky-300"><Sparkles size={14} /><span className="hidden sm:inline">Ask AI</span></button>
            </div>
          </header>
          <nav className="flex gap-2 overflow-x-auto border-b border-white/[0.07] px-5 py-2 md:hidden" aria-label="Mobile navigation">{NAV.map(({ label }) => <button key={label} onClick={() => setView(label)} className={`shrink-0 rounded-lg px-3 py-2 text-xs ${view === label ? 'bg-sky-400/15 text-sky-300' : 'text-slate-400'}`}>{label}</button>)}</nav>

          <div className="flex">
            <section className="min-w-0 flex-1 px-5 py-7 md:px-8">
              <div className="mb-7 flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
                <div><div className="mb-3 flex items-center gap-2 text-xs font-medium text-sky-300"><span className="rounded bg-sky-400/10 px-2 py-1">{view}</span><span className="text-slate-600">/</span><span className="text-slate-500">Local analytics workspace</span></div><h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">{view === 'Overview' ? 'Business overview' : view}<span className="text-sky-400">.</span></h1><p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">{view === 'Overview' ? 'Explore real metrics calculated from your selected dataset.' : 'Explore the selected dataset and its measured results.'}</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative"><span className="sr-only">Select date range</span><select value={period} onChange={(event) => selectPeriod(event.target.value)} className="appearance-none rounded-lg border border-white/[0.1] bg-[#111624] py-2.5 pl-3 pr-9 text-xs font-medium text-slate-300 outline-none focus:border-sky-400/60"><option>Last 7 days</option><option>Last 30 days</option><option>Last 90 days</option><option>Custom range</option></select><ChevronDown className="pointer-events-none absolute right-3 top-3 text-slate-500" size={14} /></label>
                  {period === 'Custom range' && <><label className="text-[10px] text-slate-500">From<input type="date" value={customStart} max={customEnd} onChange={(event) => setCustomStart(event.target.value)} className="ml-1 rounded border border-white/10 bg-[#111624] p-2 text-xs text-slate-300" /></label><label className="text-[10px] text-slate-500">To<input type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} className="ml-1 rounded border border-white/10 bg-[#111624] p-2 text-xs text-slate-300" /></label></>}
                  <button onClick={exportMetrics} disabled={!metrics || !dateRangeValid} className="flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#111624] px-3 py-2.5 text-xs font-medium text-slate-300 hover:border-sky-400/50 hover:text-white disabled:opacity-50"><Download size={14} />Export</button>
                </div>
              </div>
              {error && <div role="alert" className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-4 text-sm text-rose-200"><div><strong>Analytics service unavailable</strong><p className="mt-1 text-xs text-rose-200/75">{error}. Start the API using the README instructions, then refresh.</p></div><button onClick={() => void refresh()} aria-label="Retry"><RefreshCw size={15} /></button></div>}
              {!error && loading && !metrics && <div className="mb-5 flex items-center gap-2 text-sm text-slate-400"><LoaderCircle className="animate-spin" size={16} />Loading dataset analytics…</div>}
              {!error && !datasets.length && <EmptyState onUpload={uploadFile} uploading={uploading} />}
              {!!datasets.length && view === 'Overview' && <Overview datasets={datasets} datasetId={datasetId} onSelect={setDatasetId} metrics={metrics} quality={quality} detail={detail} onNavigate={setView} />}
              {!!datasets.length && view === 'Datasets' && <DatasetView datasets={datasets} activeId={datasetId} detail={detail} onSelect={setDatasetId} onUpload={uploadFile} uploading={uploading} onToast={showToast} onDatasetVersion={(dataset, activate) => {
                void api.datasets().then(setDatasets).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not refresh the dataset catalog.'));
                if (activate) {
                  if (datasetId === dataset.id) setDatasetRevision((revision) => revision + 1);
                  setDatasetId(dataset.id);
                }
              }} />}
              {!!datasets.length && view === 'SQL workspace' && <SQLView detail={detail} query={sql} setQuery={setSql} onRun={() => void runSql()} busy={sqlBusy} result={sqlResult} error={sqlError} history={history} onHistory={setSql} />}
              {!!datasets.length && view === 'Data quality' && <QualityView quality={quality} datasetId={datasetId} />}
              {!!datasets.length && view === 'Analytics' && <AnalyticsStudio datasets={datasets} datasetId={datasetId} onDatasetChange={setDatasetId} onToast={showToast} />}
              {!!datasets.length && view === 'Settings' && <SettingsView />}
            </section>
            {chatOpen && <aside className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-white/[0.07] bg-[#0b101b] shadow-2xl sm:w-[360px] xl:sticky xl:top-[72px] xl:h-[calc(100vh-72px)] xl:shrink-0 xl:shadow-none"><div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-5"><div className="flex items-center gap-2.5"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-400/15 text-sky-300"><WandSparkles size={15} /></div><div><p className="text-sm font-medium text-white">Data analyst</p><p className="text-[10px] text-sky-300">MCP tools · {activeDataset ? 'dataset connected' : 'choose a dataset'}</p></div></div><button onClick={() => setChatOpen(false)} className="text-slate-500 hover:text-slate-300" aria-label="Close assistant"><X size={16} /></button></div><div className="flex-1 space-y-4 overflow-auto px-5 py-5">{!chat.length && <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.06] p-4"><p className="mb-2 flex items-center gap-2 text-xs font-medium text-sky-300"><Sparkles size={13} /> Evidence-based analysis</p><p className="text-xs leading-5 text-slate-300">Ask about metrics, comparisons, dataset schema, anomalies, or data quality. Answers invoke a registered MCP tool and disclose if the LLM is not configured.</p><button onClick={() => setChatInput('Summarize the dataset')} className="mt-3 text-[11px] text-sky-300">Summarize the dataset →</button></div>}{chat.map((item, index) => <div key={`${index}-${item.role}`} className={`rounded-xl p-3 text-xs leading-5 ${item.role === 'user' ? 'ml-8 bg-sky-400/10 text-sky-100' : 'mr-3 border border-white/[0.07] bg-[#111624] text-slate-300'}`}><p>{item.text}</p>{item.evidence && <details className="mt-2 text-[10px] text-slate-500"><summary className="cursor-pointer">Evidence: {item.evidence.tool}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(item.evidence.evidence, null, 2)}</pre><p className="mt-2">{item.evidence.limitations}</p></details>}</div>)}{chatBusy && <div className="text-xs text-slate-500">Calling analysis tool…</div>}</div><div className="border-t border-white/[0.07] p-4"><form onSubmit={(event) => { event.preventDefault(); void sendChat(); }} className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#121927] px-3 py-2.5"><MessageSquareText size={15} className="shrink-0 text-slate-600" /><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask about your data…" className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-slate-600" /><button type="submit" disabled={chatBusy || !datasetId} className="text-sky-300 disabled:opacity-40" aria-label="Send question"><Send size={15} /></button></form><p className="mt-2 text-center text-[10px] text-slate-600">Descriptive evidence only · no causal claims</p></div></aside>}
          </div>
        </main>
      </div>
      {toast && <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-emerald-400/20 bg-[#121b25] px-4 py-3 text-xs font-medium text-emerald-200 shadow-2xl"><Check size={14} />{toast}</div>}
    </div>
  );
}

type IconType = typeof LayoutDashboard;
function SideIcon({ icon: Icon, label, active, onClick }: { icon: IconType; label: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} aria-label={label} aria-current={active ? 'page' : undefined} className={`group relative flex h-10 w-10 items-center justify-center rounded-lg transition ${active ? 'bg-sky-400/15 text-sky-300' : 'text-slate-600 hover:bg-white/[0.05] hover:text-slate-300'}`}><Icon size={18} /><span className="pointer-events-none absolute left-12 z-20 hidden whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-[10px] text-white shadow-xl group-hover:block">{label}</span></button>;
}

function Panel({ title, eyebrow, action, children }: { title: string; eyebrow: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 sm:p-5"><div className="flex items-start justify-between"><div><h2 className="text-sm font-medium text-white">{title}</h2><p className="mt-1 text-[10px] text-slate-500">{eyebrow}</p></div>{action}</div>{children}</div>;
}

function MetricCard({ label, value, change, positive, onClick, accent }: { label: string; value: string; change: number | null; positive?: boolean; onClick: () => void; accent: string }) {
  const styles: Record<string, string> = { sky: 'bg-sky-400/10 text-sky-300', teal: 'bg-teal-400/10 text-teal-300', blue: 'bg-blue-400/10 text-blue-300', emerald: 'bg-emerald-400/10 text-emerald-300' };
  return <button onClick={onClick} className="group rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 text-left transition hover:-translate-y-0.5 hover:border-white/[0.14]"><div className="flex items-start justify-between"><span className="text-xs text-slate-500">{label}</span><span className={`rounded-md p-1.5 ${styles[accent]}`}>{positive === false ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}</span></div><p className="mt-4 text-xl font-semibold tracking-tight text-white">{value}</p><p className="mt-2 text-[11px] text-slate-500">{change === null ? 'Comparison unavailable' : <span className={change >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{change >= 0 ? '+' : ''}{change}% vs prior period</span>}</p></button>;
}

function Overview({ datasets, datasetId, onSelect, metrics, quality, detail, onNavigate }: { datasets: Dataset[]; datasetId: string; onSelect: (value: string) => void; metrics: MetricResponse | null; quality: QualityReport | null; detail: DatasetDetail | null; onNavigate: (view: View) => void }) {
  const fmt = (value: number | null | undefined, currency = false) => value === null || value === undefined ? '—' : new Intl.NumberFormat(undefined, { style: currency ? 'currency' : 'decimal', currency: 'USD', maximumFractionDigits: currency ? 0 : 1 }).format(value);
  const change = (key: string) => metrics?.comparison[key]?.percent_change ?? null;
  const values = metrics?.series ?? [];
  const maximum = Math.max(...[...values, ...(metrics?.previous_series ?? [])].map((point) => point.revenue), 1);
  return <>
    <div className="mb-5 flex flex-wrap items-center gap-3"><label className="text-xs text-slate-500">Active dataset<select value={datasetId} onChange={(event) => onSelect(event.target.value)} className="ml-2 rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-xs text-slate-200">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.row_count.toLocaleString()} rows</option>)}</select></label><span className="text-[10px] text-slate-600">{detail?.shape.rows.toLocaleString()} rows · {detail?.shape.columns} columns</span></div>
    {!metrics && <p className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs text-amber-200">Metrics unavailable until a dataset with supported fields is selected.</p>}
    <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Net revenue" value={fmt(metrics?.metrics.revenue, true)} change={change('revenue')} onClick={() => onNavigate('Analytics')} accent="sky" />
      <MetricCard label="Active customers" value={fmt(metrics?.metrics.active_customers)} change={change('active_customers')} onClick={() => onNavigate('Analytics')} accent="teal" />
      <MetricCard label="Average order value" value={fmt(metrics?.metrics.average_order_value, true)} change={change('average_order_value')} onClick={() => onNavigate('Analytics')} accent="blue" />
      <MetricCard label="Data quality score" value={quality?.score === null ? 'N/A' : quality ? `${quality.score}%` : '—'} change={null} onClick={() => onNavigate('Data quality')} accent="emerald" />
    </div>
    <div className="mb-6 grid gap-4 xl:grid-cols-[1.55fr_1fr]">
      <Panel title="Revenue performance" eyebrow={metrics ? `${metrics.period.start} – ${metrics.period.end} · compared with preceding ${metrics.period.days} days` : 'Waiting for dataset'}>
        <div className="mt-6 flex items-end justify-between"><div><span className="text-3xl font-semibold tracking-tight text-white">{fmt(metrics?.metrics.revenue, true)}</span><span className="ml-3 text-xs text-slate-500">{metrics?.supported.revenue ? 'period revenue' : 'revenue field not detected'}</span></div>{metrics?.comparison.revenue?.percent_change !== null && metrics?.comparison.revenue?.percent_change !== undefined && <span className={`rounded-full px-2 py-1 text-[11px] ${metrics.comparison.revenue.percent_change >= 0 ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>{metrics.comparison.revenue.percent_change > 0 ? '+' : ''}{metrics.comparison.revenue.percent_change}%</span>}</div>
        {values.length ? <><div className="mt-7 flex h-[190px] items-end gap-1 border-b border-white/[0.07] px-1">{values.map((point, index) => { const previous = metrics?.previous_series?.[index]; return <div key={point.date} className="flex h-full flex-1 items-end gap-px" title={`${point.date}: ${fmt(point.revenue, true)}${previous ? ` · previous period ${previous.date}: ${fmt(previous.revenue, true)}` : ''}`}><div className="w-1/2 rounded-t-sm bg-gradient-to-t from-sky-500/35 to-sky-300/90 hover:to-sky-200" style={{ height: `${Math.max(point.revenue / maximum * 100, 2)}%` }} />{previous && <div className="w-1/2 rounded-t-sm bg-slate-600/80 hover:bg-slate-400" style={{ height: `${Math.max(previous.revenue / maximum * 100, 2)}%` }} />}</div>; })}</div><div className="mt-3 flex justify-between text-[10px] text-slate-600"><span>{values[0]?.date}</span><span>{values[values.length - 1]?.date}</span></div><div className="mt-4 flex gap-4 text-[10px] text-slate-400"><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-sky-400" />Current period</span><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-slate-500" />Previous period</span></div></> : <div className="mt-6 flex h-40 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500">{metrics?.supported.dates ? 'No revenue rows in this range.' : 'A recognized date and revenue column are required for a time series.'}</div>}
      </Panel>
      <Panel title="Dataset snapshot" eyebrow="Actual source metadata">
        <div className="mt-6 grid grid-cols-2 gap-3"><Snapshot label="Rows" value={detail?.shape.rows.toLocaleString() ?? '—'} /><Snapshot label="Columns" value={detail?.shape.columns.toLocaleString() ?? '—'} /><Snapshot label="Orders" value={fmt(metrics?.metrics.orders)} /><Snapshot label="Quality issues" value={quality?.issues.length.toString() ?? '—'} /></div><button onClick={() => onNavigate('Datasets')} className="mt-6 flex items-center gap-1 text-xs font-medium text-sky-300">Inspect schema <ChevronRight size={14} /></button>
      </Panel>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Data quality" eyebrow={quality ? quality.calculation : 'No quality report yet'} action={<button onClick={() => onNavigate('Data quality')} className="text-xs text-sky-300">View report</button>}>
        {quality ? <><div className="mt-5 flex items-center gap-4"><div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-emerald-400/70 text-lg font-semibold text-white">{quality.score}%</div><div><p className="text-sm font-medium text-white">{quality.issues.length ? `${quality.issues.length} issue types found` : 'No missing or duplicate records detected'}</p><p className="mt-1 text-xs text-slate-500">{quality.missing_values} missing cells · {quality.duplicate_count} duplicate rows</p></div></div><p className="mt-5 border-t border-white/[0.07] pt-4 text-[10px] leading-5 text-slate-500">{quality.calculation}</p></> : <EmptyMessage text="Quality results appear when the API is available." />}
      </Panel>
      <Panel title="Recent activity" eyebrow="Live workspace state"><div className="mt-5 flex items-start gap-3"><div className="rounded-lg bg-sky-400/10 p-2 text-sky-300"><Database size={15} /></div><div><p className="text-xs font-medium text-slate-200">{datasets.length} dataset{datasets.length === 1 ? '' : 's'} available</p><p className="mt-1 text-[11px] text-slate-500">{detail?.dataset.uploaded_at ? `Selected data imported ${new Date(detail.dataset.uploaded_at).toLocaleString()}` : 'No recent activity recorded.'}</p></div></div></Panel>
    </div>
    <div className="mt-6 rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 sm:p-5"><div className="flex flex-col gap-4 md:flex-row md:items-center"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300"><TerminalSquare size={19} /></div><div className="flex-1"><p className="text-sm font-medium text-white">Explore with read-only SQL</p><p className="mt-1 text-xs text-slate-500">Queries are restricted to the selected dataset and capped at 1,000 rows.</p></div><button onClick={() => onNavigate('SQL workspace')} className="rounded-lg bg-sky-400 px-3 py-2 text-xs font-semibold text-[#07101b]">Open SQL workspace</button></div></div>
  </>;
}

function Snapshot({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-white/[0.03] p-3"><p className="text-[10px] text-slate-500">{label}</p><p className="mt-1 text-sm font-medium text-white">{value}</p></div>;
}

function DatasetView({
  datasets, activeId, detail, onSelect, onUpload, uploading, onToast, onDatasetVersion,
}: {
  datasets: Dataset[];
  activeId: string;
  detail: DatasetDetail | null;
  onSelect: (value: string) => void;
  onUpload: (file?: File) => void;
  uploading: boolean;
  onToast: (message: string) => void;
  onDatasetVersion: (dataset: Dataset, activate: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [records, setRecords] = useState<{ total: number; columns: string[]; rows: Array<Record<string, unknown>>; limit: number } | null>(null);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [editorDataset, setEditorDataset] = useState<Dataset | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    setRecordsBusy(true);
    api.records(activeId, offset, 50, search).then((result) => {
      if (alive) {
        setRecords(result);
        setRecordsError('');
      }
    }).catch((reason: unknown) => {
      if (alive) setRecordsError(reason instanceof Error ? reason.message : 'Could not load dataset records.');
    }).finally(() => { if (alive) setRecordsBusy(false); });
    return () => { alive = false; };
  }, [activeId, offset, search]);
  const openEditor = async (dataset: Dataset) => {
    setEditorBusy(true);
    setEditorError('');
    try {
      const workingCopy = await api.createEditorWorkingCopy(dataset.id);
      onDatasetVersion(workingCopy, true);
      setEditorDataset(workingCopy);
    } catch (reason) {
      setEditorError(reason instanceof Error ? reason.message : 'Could not create the editor working copy.');
    } finally {
      setEditorBusy(false);
    }
  };
  return <div className="space-y-5">
    <Panel title="Your datasets" eyebrow={`${datasets.length} imported dataset${datasets.length === 1 ? '' : 's'}`} action={<label className="flex cursor-pointer items-center gap-2 rounded-lg bg-sky-400 px-3 py-2 text-xs font-semibold text-[#07101b]"><Upload size={13} />{uploading ? 'Uploading…' : 'Upload CSV'}<input type="file" accept=".csv,text/csv" className="sr-only" disabled={uploading} onChange={(event) => onUpload(event.target.files?.[0])} /></label>}>
      <div className="mt-4 space-y-2">{datasets.map((dataset) => <div key={dataset.id} className={`flex items-center gap-3 rounded-lg border p-3 transition ${dataset.id === activeId ? 'border-sky-400/30 bg-sky-400/[0.06]' : 'border-white/[0.06]'}`}>
        <button onClick={() => { onSelect(dataset.id); setOffset(0); }} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="rounded-lg bg-sky-400/10 p-2 text-sky-300"><Table2 size={16} /></div>
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-white">{dataset.name}</p><p className="mt-1 text-[10px] text-slate-500">{dataset.row_count.toLocaleString()} rows · {dataset.column_count} columns · imported {new Date(dataset.uploaded_at).toLocaleDateString()}</p></div>
          {dataset.role && <span className="rounded-full bg-violet-400/10 px-2 py-1 text-[10px] text-violet-300">{dataset.role === 'working_copy' ? 'Working copy' : 'Saved copy'}</span>}
          <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-300">{dataset.status}</span>
        </button>
        <button onClick={() => void openEditor(dataset)} disabled={editorBusy} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-400/20 px-3 py-2 text-[10px] font-medium text-sky-300 hover:bg-sky-400/[0.06] disabled:opacity-50">{editorBusy ? <LoaderCircle size={13} className="animate-spin" /> : <Table2 size={13} />}{editorBusy ? 'Opening…' : 'Edit Dataset'}</button>
      </div>)}</div>
      {editorError && <p role="alert" className="mt-3 text-xs text-rose-300">{editorError}</p>}
    </Panel>
    {detail && <><Panel title="Schema" eyebrow={`${detail.shape.rows.toLocaleString()} rows × ${detail.shape.columns} columns`}><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="pb-2">Column</th><th className="pb-2">Inferred type</th></tr></thead><tbody>{detail.columns.map((column) => <tr key={column.name} className="border-t border-white/[0.06]"><td className="py-2 font-medium text-slate-200">{column.name}</td><td className="py-2 text-slate-500">{column.type}</td></tr>)}</tbody></table></div></Panel>
      <Panel title="Dataset records" eyebrow={records ? `${records.total.toLocaleString()} matching rows` : 'Search and page through the source data'} action={<input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Search records…" aria-label="Search dataset records" className="w-40 rounded-lg border border-white/10 bg-[#111624] px-3 py-2 text-[10px] text-white" />}>
        {recordsError && <p role="alert" className="my-3 text-xs text-rose-300">{recordsError}</p>}
        {recordsBusy ? <div className="py-8 text-center text-xs text-slate-500">Loading records…</div> : records ? <><DataTable rows={records.rows} columns={records.columns} /><div className="mt-3 flex items-center justify-between text-[10px] text-slate-500"><span>{records.total ? `${offset + 1}–${Math.min(offset + records.rows.length, records.total)} of ${records.total}` : 'No matching records'}</span><div className="flex gap-2"><button onClick={() => setOffset((value) => Math.max(0, value - 50))} disabled={offset === 0} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">Previous</button><button onClick={() => setOffset((value) => value + 50)} disabled={offset + 50 >= records.total} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">Next</button></div></div></> : <EmptyMessage text="No data loaded." />}
      </Panel></>}
    {editorDataset && <DatasetEditor dataset={editorDataset} onClose={() => setEditorDataset(null)} onSaved={(updated) => onDatasetVersion(updated, updated.role === 'working_copy')} onToast={onToast} />}
  </div>;
}

function SQLView({ detail, query, setQuery, onRun, busy, result, error, history, onHistory }: { detail: DatasetDetail | null; query: string; setQuery: (value: string) => void; onRun: () => void; busy: boolean; result: QueryResult | null; error: string; history: string[]; onHistory: (value: string) => void }) {
  return <div className="grid gap-4 xl:grid-cols-[280px_1fr]"><Panel title="Schema explorer" eyebrow={detail?.dataset.name ?? 'Selected dataset'}><div className="mt-4 space-y-2">{detail?.columns.map((column) => <div key={column.name} className="flex justify-between gap-3 rounded bg-white/[0.03] px-3 py-2 text-xs"><span className="text-slate-200">{column.name}</span><span className="text-slate-500">{column.type}</span></div>)}</div>{history.length > 0 && <><p className="mb-2 mt-6 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Recent queries</p>{history.map((item, index) => <button key={`${index}-${item}`} onClick={() => onHistory(item)} className="mb-2 block w-full truncate rounded bg-white/[0.03] px-2 py-2 text-left font-mono text-[10px] text-slate-400 hover:text-sky-300">{item}</button>)}</>}</Panel><div className="space-y-4"><Panel title="SQL workspace" eyebrow="One SELECT statement · read-only · 1,000 row maximum"><textarea aria-label="SQL query" value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} className="mt-4 min-h-44 w-full resize-y rounded-lg border border-white/[0.08] bg-[#090d16] p-4 font-mono text-xs leading-6 text-sky-100 outline-none focus:border-sky-400/50" /><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-[10px] text-slate-500">Dataset table: <code className="text-sky-300">dataset_&lt;internal_id&gt;</code></p><button onClick={onRun} disabled={busy} className="flex items-center gap-2 rounded-lg bg-sky-400 px-4 py-2 text-xs font-semibold text-[#07101b] disabled:opacity-50"><Play size={13} fill="currentColor" />{busy ? 'Running…' : 'Run query'}</button></div>{error && <p role="alert" className="rounded-lg border border-rose-400/20 bg-rose-400/[0.05] p-3 text-xs text-rose-200">{error}</p>}</Panel>{result && <Panel title="Query results" eyebrow={`${result.row_count} rows · ${result.duration_ms} ms · read-only`} action={<button onClick={() => downloadCsv(result.rows, result.columns, 'query-results.csv')} className="flex items-center gap-1 text-xs text-sky-300"><Download size={13} />CSV</button>}><DataTable rows={result.rows} columns={result.columns} /></Panel>}</div></div>;
}

function QualityView({ quality, datasetId }: { quality: QualityReport | null; datasetId: string }) {
  return <div className="space-y-4"><Panel title="Data quality report" eyebrow={quality?.calculation ?? 'Reproducible data validation and statistical warnings'} action={<button onClick={() => window.location.assign(`/api/exports/quality?dataset_id=${encodeURIComponent(datasetId)}`)} disabled={!quality} className="flex items-center gap-1 text-xs text-sky-300 disabled:opacity-40"><Download size={13} />Export report</button>}>{quality ? <><div className="mt-5 grid gap-3 sm:grid-cols-3"><Snapshot label="Quality score" value={quality.score === null ? 'N/A' : `${quality.score}%`} /><Snapshot label="Missing cells" value={quality.missing_values.toLocaleString()} /><Snapshot label="Duplicate rows" value={quality.duplicate_count.toLocaleString()} /></div><p className="mt-4 text-[10px] leading-5 text-slate-500">{quality.calculation} The score uses missingness and exact duplicates; type/date checks are validations and outliers are statistical warnings.</p></> : <EmptyMessage text="Quality report is loading or unavailable." />}</Panel>{quality && <Panel title="Column checks" eyebrow="Observed values; no source data is modified"><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-2">Column</th><th>Type</th><th>Missing</th><th>Type flags</th><th>Invalid dates</th><th>Distinct</th><th>Mean (numeric)</th></tr></thead><tbody>{quality.columns.map((column) => <tr key={column.name} className="border-t border-white/[0.06]"><td className="py-3 font-medium text-white">{column.name}</td><td className="text-slate-400">{column.type}</td><td className={column.missing ? 'text-amber-300' : 'text-emerald-300'}>{column.missing} ({column.missing_percent}%)</td><td className={column.type_inconsistencies ? 'text-amber-300' : 'text-slate-400'}>{column.type_inconsistencies}</td><td className={column.invalid_dates ? 'text-amber-300' : 'text-slate-400'}>{column.invalid_dates}</td><td className="text-slate-400">{column.unique}</td><td className="text-slate-400">{column.statistics.mean ?? '—'}</td></tr>)}</tbody></table></div></Panel>}{quality && <Panel title={`Detected issues (${quality.issues.length})`} eyebrow="Objective checks and statistical warnings"><div className="mt-3 space-y-2">{quality.issues.length ? quality.issues.map((issue, index) => <div key={`${issue.type}-${issue.column}-${index}`} className="rounded-lg border border-amber-400/15 bg-amber-400/[0.04] p-3"><div className="flex justify-between gap-3"><p className="text-xs font-medium text-slate-200">{issue.description}</p><span className="text-[10px] uppercase text-amber-300">{issue.severity}</span></div><p className="mt-1 text-[10px] text-slate-500">{issue.recommendation}</p></div>) : <p className="py-5 text-center text-xs text-emerald-300">No quality checks produced findings.</p>}</div></Panel>}</div>;
}

function SettingsView() {
  return <Panel title="Workspace configuration" eyebrow="Local demo mode"><div className="mt-4 space-y-3 text-xs leading-5 text-slate-400"><p>Datasets are stored in the local SQLite database configured by <code className="text-sky-300">DATAPILOT_DB_PATH</code>. This demo does not implement user accounts or dataset ownership.</p><p>The analyst uses the official MCP client and registered DataPilot tools. It uses deterministic summaries because no LLM provider is configured.</p><p>Configure allowed browser origins with <code className="text-sky-300">DATAPILOT_CORS_ORIGINS</code>. Keep this local service behind an authenticated gateway before deployment.</p><p>CSV import is limited to 10 MB. XLSX import is not enabled.</p></div></Panel>;
}

function EmptyState({ onUpload, uploading }: { onUpload: (file?: File) => void; uploading: boolean }) {
  return <div className="rounded-2xl border border-dashed border-white/10 bg-[#0e1421] px-6 py-16 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300"><Database size={22} /></div><h2 className="mt-4 text-lg font-medium text-white">No dataset available</h2><p className="mx-auto mt-2 max-w-md text-sm text-slate-500">When the API starts, it seeds a sample sales dataset. You can also upload a UTF-8 CSV to begin analysis.</p><label className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-sky-400 px-4 py-2.5 text-xs font-semibold text-[#07101b]"><Upload size={14} />{uploading ? 'Uploading…' : 'Upload CSV'}<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => onUpload(event.target.files?.[0])} /></label></div>;
}

function EmptyMessage({ text }: { text: string }) {
  return <p className="py-8 text-center text-xs text-slate-500">{text}</p>;
}

function DataTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns?: string[] }) {
  if (!rows.length) return <EmptyMessage text="No rows to display." />;
  const names = columns ?? Object.keys(rows[0]);
  return <div className="mt-4 max-h-[420px] overflow-auto"><table className="w-full min-w-max text-left text-xs"><thead className="sticky top-0 bg-[#101725] text-[10px] uppercase text-slate-500"><tr>{names.map((name) => <th key={name} className="px-3 py-2">{name}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-t border-white/[0.06]">{names.map((name) => <td key={name} className="max-w-64 truncate px-3 py-2 text-slate-300">{row[name] === null || row[name] === undefined ? <span className="text-slate-600">NULL</span> : String(row[name])}</td>)}</tr>)}</tbody></table></div>;
}

function downloadCsv(rows: Array<Record<string, unknown>>, columns: string[], filename: string) {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [columns.map(escape).join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default App;
