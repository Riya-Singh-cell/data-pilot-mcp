import { useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  FileCode2,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Table2,
  TerminalSquare,
  WandSparkles,
  X,
} from 'lucide-react';

const chartPoints = [38, 47, 43, 58, 55, 72, 67, 86, 81, 95, 91, 108];
const categories = [
  { name: 'Subscription', value: '$842k', width: '92%', color: 'bg-sky-400' },
  { name: 'Professional', value: '$516k', width: '65%', color: 'bg-cyan-400' },
  { name: 'Enterprise', value: '$394k', width: '49%', color: 'bg-teal-400' },
  { name: 'Services', value: '$183k', width: '23%', color: 'bg-slate-500' },
];

function App() {
  const [activeView, setActiveView] = useState('Overview');
  const [chatOpen, setChatOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('Last 90 days');
  const [toast, setToast] = useState('');

  const showToast = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2400);
  };

  const runQuery = (): void => {
    showToast(query.trim() ? 'Query completed in 184ms' : 'Loaded the latest revenue snapshot');
    setQuery('');
  };

  return (
    <div className="min-h-screen bg-[#080b13] text-slate-200 selection:bg-sky-400/30">
      <div className="flex min-h-screen">
        <aside className="hidden w-[74px] shrink-0 flex-col items-center border-r border-white/[0.07] bg-[#0b0f1a] py-5 md:flex">
          <div className="mb-10 flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400 text-[#07101b] shadow-[0_0_26px_rgba(56,189,248,0.3)]">
            <Database size={20} strokeWidth={2.5} />
          </div>
          <nav className="flex flex-1 flex-col items-center gap-3" aria-label="Primary navigation">
            <SideIcon icon={LayoutDashboard} label="Overview" active={activeView === 'Overview'} onClick={() => setActiveView('Overview')} />
            <SideIcon icon={Table2} label="Datasets" active={activeView === 'Datasets'} onClick={() => setActiveView('Datasets')} />
            <SideIcon icon={TerminalSquare} label="SQL runner" active={activeView === 'SQL runner'} onClick={() => setActiveView('SQL runner')} />
            <SideIcon icon={Activity} label="Quality" active={activeView === 'Quality'} onClick={() => setActiveView('Quality')} />
            <SideIcon icon={BarChart3} label="Trends" active={activeView === 'Trends'} onClick={() => setActiveView('Trends')} />
          </nav>
          <div className="flex flex-col items-center gap-5 text-slate-500">
            <button className="transition hover:text-slate-200" aria-label="Help"><CircleHelp size={18} /></button>
            <button className="transition hover:text-slate-200" aria-label="Settings"><Settings2 size={18} /></button>
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-[11px] font-semibold text-sky-300">JD</div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="flex h-[72px] items-center justify-between border-b border-white/[0.07] px-5 md:px-8">
            <div className="flex items-center gap-3">
              <button className="rounded-lg p-2 text-slate-400 hover:bg-white/[0.05] hover:text-white md:hidden" aria-label="Open menu"><Menu size={19} /></button>
              <div className="hidden items-center gap-2 text-sm text-slate-500 sm:flex"><span>Workspace</span><ChevronRight size={14} /><span className="text-slate-300">Analytics</span></div>
              <ChevronRight className="hidden text-slate-600 sm:block" size={15} />
              <div className="flex items-center gap-2 text-sm font-medium text-white"><div className="h-2 w-2 rounded-full bg-emerald-400" />Revenue Intelligence</div>
            </div>
            <div className="flex items-center gap-2 md:gap-4">
              <div className="hidden items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-slate-400 lg:flex"><Search size={14} /> Search anything <kbd className="ml-5 rounded border border-white/10 px-1.5 py-0.5 text-[10px]">⌘ K</kbd></div>
              <button className="relative rounded-lg p-2 text-slate-400 hover:bg-white/[0.05] hover:text-white" aria-label="Notifications"><Bell size={17} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-sky-400" /></button>
              <button onClick={() => showToast('Dashboard refreshed')} className="hidden items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-sky-400/30 hover:bg-sky-400/5 sm:flex"><RefreshCw size={14} /> Refresh</button>
              <button onClick={() => setChatOpen(!chatOpen)} className="flex items-center gap-2 rounded-lg bg-sky-400 px-3 py-2 text-xs font-semibold text-[#07101b] transition hover:bg-sky-300"><Sparkles size={14} /> <span className="hidden sm:inline">Ask AI</span></button>
            </div>
          </header>

          <div className="flex">
            <section className="min-w-0 flex-1 px-5 py-7 md:px-8">
              <div className="mb-7 flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
                <div>
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium text-sky-300"><span className="rounded bg-sky-400/10 px-2 py-1">{activeView}</span><span className="text-slate-600">/</span><span className="text-slate-500">Live workspace</span></div>
                  <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">Good morning, Jordan<span className="text-sky-400">.</span></h1>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">A clear view of your business performance, data health, and the signals that matter today.</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="relative"><span className="sr-only">Select date range</span><select value={period} onChange={(event) => setPeriod(event.target.value)} className="appearance-none rounded-lg border border-white/[0.1] bg-[#111624] py-2.5 pl-3 pr-9 text-xs font-medium text-slate-300 outline-none transition focus:border-sky-400/60"><option>Last 90 days</option><option>Last 30 days</option><option>This year</option></select><ChevronDown className="pointer-events-none absolute right-3 top-3 text-slate-500" size={14} /></label>
                  <button onClick={() => showToast('Report export is ready')} className="flex items-center gap-2 rounded-lg border border-white/[0.1] bg-[#111624] px-3 py-2.5 text-xs font-medium text-slate-300 transition hover:border-sky-400/50 hover:text-white"><Download size={14} /> Export</button>
                </div>
              </div>

              <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Net revenue" value="$2.84M" change="18.6%" positive icon={ArrowUpRight} accent="sky" />
                <MetricCard label="Active customers" value="12,846" change="8.2%" positive icon={ArrowUpRight} accent="teal" />
                <MetricCard label="Avg. contract value" value="$18,420" change="4.1%" positive icon={ArrowUpRight} accent="blue" />
                <MetricCard label="Data quality score" value="94.8%" change="2.3%" positive icon={ArrowUpRight} accent="emerald" />
              </div>

              <div className="mb-6 grid gap-4 xl:grid-cols-[1.55fr_1fr]">
                <Panel title="Revenue performance" eyebrow={`Compared to previous ${period.toLowerCase()}`} action={<button className="text-slate-500 hover:text-white"><MoreHorizontal size={18} /></button>}>
                  <div className="mt-7 flex items-end justify-between"><div><span className="text-3xl font-semibold tracking-tight text-white">$2,842,910</span><span className="ml-3 rounded-full bg-emerald-400/10 px-2 py-1 text-[11px] font-medium text-emerald-300">+18.6%</span></div><div className="hidden text-right sm:block"><p className="text-[11px] text-slate-500">Projected finish</p><p className="text-sm font-medium text-slate-300">$3.21M</p></div></div>
                  <div className="relative mt-7 h-[190px] overflow-hidden"><div className="absolute inset-0 flex flex-col justify-between"><div className="border-t border-dashed border-white/[0.07]" /><div className="border-t border-dashed border-white/[0.07]" /><div className="border-t border-dashed border-white/[0.07]" /><div className="border-t border-dashed border-white/[0.07]" /><div className="border-t border-dashed border-white/[0.07]" /></div><div className="absolute bottom-0 left-0 right-0 top-0 flex items-end gap-1 sm:gap-2">{chartPoints.map((point, index) => <div key={index} className="group relative flex-1"><div className="absolute bottom-0 left-1/2 hidden -translate-x-1/2 -translate-y-2 rounded bg-slate-800 px-2 py-1 text-[10px] text-white shadow-xl group-hover:block">${(point * 24.2).toFixed(0)}k</div><div className="mx-auto w-full rounded-t-sm bg-gradient-to-t from-sky-500/35 to-sky-300/90 transition-all duration-300 group-hover:from-sky-500/60 group-hover:to-sky-200" style={{ height: `${point}%` }} /></div>)}</div></div>
                  <div className="mt-3 flex justify-between text-[10px] text-slate-600"><span>Apr 01</span><span>May 01</span><span>Jun 01</span><span>Jun 30</span></div>
                  <div className="mt-5 flex items-center gap-5 text-[11px] text-slate-400"><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-sky-400" />Actual revenue</span><span className="flex items-center gap-2"><i className="h-2 w-2 rounded-full border border-dashed border-slate-500" />Forecast</span></div>
                </Panel>
                <Panel title="Revenue by segment" eyebrow="Current period" action={<button className="text-slate-500 hover:text-white"><MoreHorizontal size={18} /></button>}>
                  <div className="mt-7 space-y-5">{categories.map((category) => <div key={category.name}><div className="mb-2 flex justify-between text-xs"><span className="text-slate-300">{category.name}</span><span className="font-medium text-white">{category.value}</span></div><div className="h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className={`h-full rounded-full ${category.color} transition-all duration-500`} style={{ width: category.width }} /></div></div>)}</div>
                  <button onClick={() => setActiveView('Trends')} className="mt-8 flex items-center gap-1 text-xs font-medium text-sky-300 transition hover:text-sky-200">View segment analysis <ChevronRight size={14} /></button>
                </Panel>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <Panel title="Data health" eyebrow="Automated quality checks" action={<button onClick={() => setActiveView('Quality')} className="text-xs font-medium text-sky-300 hover:text-sky-200">View all</button>}>
                  <div className="mt-6 flex items-center gap-5"><div className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full" style={{ background: 'conic-gradient(#34d399 0 94.8%, #1f2937 94.8% 100%)' }}><div className="flex h-[76px] w-[76px] items-center justify-center rounded-full bg-[#111624]"><span className="text-xl font-semibold text-white">94.8</span></div></div><div><p className="text-sm font-medium text-white">Healthy dataset</p><p className="mt-1 text-xs leading-5 text-slate-500">Last checked 8 minutes ago<br />across 4 connected sources.</p></div></div>
                  <div className="mt-7 grid grid-cols-3 gap-2 border-t border-white/[0.07] pt-5"><HealthStat label="Completeness" value="98.2%" color="text-emerald-300" /><HealthStat label="Duplicates" value="0.4%" color="text-amber-300" /><HealthStat label="Freshness" value="100%" color="text-sky-300" /></div>
                </Panel>
                <Panel title="Recent activity" eyebrow="Your workspace" action={<button className="text-slate-500 hover:text-white"><MoreHorizontal size={18} /></button>}>
                  <div className="mt-5 space-y-1">{[['profile_data', 'revenue_events', '8 min ago', 'emerald'], ['compare_periods', 'subscription_mrr', '34 min ago', 'sky'], ['run_readonly_sql', 'customer_health', '1 hr ago', 'amber']].map(([tool, dataset, time, color]) => <div key={tool} className="flex items-center gap-3 rounded-lg px-2 py-3 transition hover:bg-white/[0.04]"><div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color === 'emerald' ? 'bg-emerald-400/10 text-emerald-300' : color === 'sky' ? 'bg-sky-400/10 text-sky-300' : 'bg-amber-400/10 text-amber-300'}`}><FileCode2 size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-slate-200">{tool}</p><p className="truncate text-[11px] text-slate-500">{dataset}</p></div><span className="shrink-0 text-[10px] text-slate-600">{time}</span></div>)}</div>
                </Panel>
              </div>

              <div className="mt-6 rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 sm:p-5"><div className="flex flex-col gap-4 md:flex-row md:items-center"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300"><TerminalSquare size={19} /></div><div className="flex-1"><p className="text-sm font-medium text-white">Explore your data with SQL</p><p className="mt-1 text-xs text-slate-500">Run a read-only query against a connected dataset.</p></div><div className="flex min-w-0 flex-1 items-center rounded-lg border border-white/[0.09] bg-[#090d16] focus-within:border-sky-400/60"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && runQuery()} placeholder="e.g. Show monthly recurring revenue" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-xs text-white outline-none placeholder:text-slate-600" /><button onClick={runQuery} className="m-1 flex items-center gap-1.5 rounded-md bg-sky-400 px-3 py-2 text-xs font-semibold text-[#07101b] transition hover:bg-sky-300"><Play size={12} fill="currentColor" /> Run</button></div></div></div>
            </section>

            {chatOpen && <aside className="hidden w-[330px] shrink-0 border-l border-white/[0.07] bg-[#0b101b] xl:block"><div className="sticky top-0 flex h-[calc(100vh-72px)] flex-col"><div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-5"><div className="flex items-center gap-2.5"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-400/15 text-sky-300"><WandSparkles size={15} /></div><div><p className="text-sm font-medium text-white">Insight assistant</p><p className="text-[10px] text-emerald-400">Online · knows your data</p></div></div><button onClick={() => setChatOpen(false)} className="text-slate-600 hover:text-slate-300" aria-label="Close assistant"><X size={16} /></button></div><div className="flex-1 overflow-auto px-5 py-6"><div className="mb-5 rounded-xl border border-sky-400/15 bg-sky-400/[0.06] p-4"><div className="mb-3 flex items-center gap-2 text-xs font-medium text-sky-300"><Sparkles size={13} /> Suggested insight</div><p className="text-xs leading-5 text-slate-300">Revenue is up 18.6% this period, driven primarily by Subscription accounts in North America.</p><button onClick={() => showToast('Opening revenue breakdown')} className="mt-4 text-[11px] font-medium text-sky-300 hover:text-sky-200">Show me why <ChevronRight className="inline" size={12} /></button></div><p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">Today</p><div className="space-y-5"><ChatMessage text="What should I pay attention to today?" user /><ChatMessage text="Your data is healthy. The biggest signal is a 24% lift in enterprise expansion revenue. I also noticed a small drop in trial-to-paid conversion — want me to investigate?" /></div></div><div className="border-t border-white/[0.07] p-4"><div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#121927] px-3 py-2.5"><MessageSquareText size={15} className="text-slate-600" /><input placeholder="Ask about your data..." className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-slate-600" /><button onClick={() => showToast('Ask AI is ready for your question')} className="text-sky-300 hover:text-sky-200" aria-label="Send message"><ArrowUpRight size={16} /></button></div><p className="mt-2 text-center text-[10px] text-slate-600">AI can make mistakes. Check important numbers.</p></div></div></aside>}
          </div>
        </main>
      </div>
      {toast && <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-emerald-400/20 bg-[#121b25] px-4 py-3 text-xs font-medium text-emerald-200 shadow-2xl"><ArrowUpRight size={14} /> {toast}</div>}
    </div>
  );
}

type IconType = typeof LayoutDashboard;
function SideIcon({ icon: Icon, label, active, onClick }: { icon: IconType; label: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} aria-label={label} className={`group relative flex h-10 w-10 items-center justify-center rounded-lg transition ${active ? 'bg-sky-400/15 text-sky-300' : 'text-slate-600 hover:bg-white/[0.05] hover:text-slate-300'}`}><Icon size={18} /> <span className="pointer-events-none absolute left-12 z-20 hidden whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-[10px] text-white shadow-xl group-hover:block">{label}</span></button>;
}

function MetricCard({ label, value, change, positive, icon: Icon, accent }: { label: string; value: string; change: string; positive: boolean; icon: IconType; accent: string }) {
  const accentStyles: Record<string, string> = { sky: 'bg-sky-400/10 text-sky-300', teal: 'bg-teal-400/10 text-teal-300', blue: 'bg-blue-400/10 text-blue-300', emerald: 'bg-emerald-400/10 text-emerald-300' };
  return <div className="group rounded-xl border border-white/[0.08] bg-[#0e1421] p-4 transition hover:-translate-y-0.5 hover:border-white/[0.14]"><div className="flex items-start justify-between"><span className="text-xs text-slate-500">{label}</span><div className={`rounded-md p-1.5 ${accentStyles[accent]}`}><Icon size={14} /></div></div><p className="mt-4 text-xl font-semibold tracking-tight text-white">{value}</p><p className={`mt-2 flex items-center gap-1 text-[11px] ${positive ? 'text-emerald-300' : 'text-rose-300'}`}><ArrowUpRight size={12} />{change}<span className="text-slate-600">vs last period</span></p></div>;
}

function Panel({ title, eyebrow, action, children }: { title: string; eyebrow: string; action: React.ReactNode; children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/[0.08] bg-[#0e1421] p-5"><div className="flex items-start justify-between"><div><h2 className="text-sm font-medium text-white">{title}</h2><p className="mt-1 text-[11px] text-slate-600">{eyebrow}</p></div>{action}</div>{children}</div>;
}

function HealthStat({ label, value, color }: { label: string; value: string; color: string }) {
  return <div><p className="text-[10px] text-slate-600">{label}</p><p className={`mt-1 text-sm font-medium ${color}`}>{value}</p></div>;
}

function ChatMessage({ text, user = false }: { text: string; user?: boolean }) {
  return <div className={`flex gap-2.5 ${user ? 'flex-row-reverse' : ''}`}><div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${user ? 'bg-white/[0.08] text-slate-400' : 'bg-sky-400/15 text-sky-300'}`}>{user ? <span className="text-[9px] font-semibold">JD</span> : <Sparkles size={12} />}</div><div className={`rounded-xl px-3 py-2.5 text-xs leading-5 ${user ? 'bg-white/[0.07] text-slate-300' : 'bg-[#121927] text-slate-400'}`}>{text}</div></div>;
}

export default App;
