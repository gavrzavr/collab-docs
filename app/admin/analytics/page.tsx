/**
 * /admin/analytics — product health dashboard.
 *
 * Server component on purpose: session check + stats fetch happen on
 * the server, so we never ship ADMIN_SECRET to the browser and the
 * page renders with data in the first HTML response.
 *
 * Access: ADMIN_EMAILS (comma-sep) in env. Non-admins get 404-shaped
 * "not found" to avoid leaking the page's existence.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { isAdminEmail } from "@/lib/admin";
import { fetchAdminStats, type AdminStats } from "@/lib/ws-api";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    notFound();
  }

  const { days: daysParam } = await searchParams;
  const days = Math.min(90, Math.max(1, Number(daysParam) || 30));

  let stats: AdminStats;
  try {
    stats = await fetchAdminStats(days);
  } catch (e) {
    return (
      <ErrorShell title="Analytics unavailable">
        <p className="text-sm text-gray-600">
          Couldn&apos;t reach the analytics endpoint on the WS server.
        </p>
        <pre className="mt-4 p-3 bg-gray-100 rounded text-xs text-gray-700 overflow-auto">
          {String(e)}
        </pre>
      </ErrorShell>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-black">
            <span aria-hidden="true" className="inline-block w-4 h-4 rounded-sm bg-[#0BA70B]" />
            <span>PostPaper</span>
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-sm font-medium text-gray-500">Analytics</h1>
        </div>
        <WindowToggle currentDays={days} />
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        <KpiGrid stats={stats} />
        <FunnelSection stats={stats} />
        <DailySection stats={stats} />
        <CohortSection stats={stats} />
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ToolBreakdown stats={stats} />
          <TopDocs stats={stats} />
        </section>
        <footer className="text-xs text-gray-400 pt-4">
          Generated {new Date(stats.generatedAt).toLocaleString()} · window {stats.windowDays}d
        </footer>
      </main>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────

function ErrorShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-white border border-gray-200 rounded-lg p-6">
        <h1 className="text-lg font-semibold mb-2">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function WindowToggle({ currentDays }: { currentDays: number }) {
  const options = [7, 30, 90];
  return (
    <nav className="flex items-center gap-1 text-xs">
      {options.map((d) => (
        <Link
          key={d}
          href={`/admin/analytics?days=${d}`}
          className={
            "px-2.5 py-1 rounded-md transition-colors " +
            (d === currentDays
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100")
          }
        >
          {d}d
        </Link>
      ))}
    </nav>
  );
}

// ─── KPIs ─────────────────────────────────────────────────────────────

function KpiGrid({ stats }: { stats: AdminStats }) {
  const t = stats.totals;
  const aiPenetration = t.users ? Math.round((t.usersWithAi / t.users) * 100) : 0;
  const docsWithAiPct = t.docs ? Math.round((t.docsWithAi / t.docs) * 100) : 0;

  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Totals
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Total users" value={t.users} />
        <KpiCard label="Total docs" value={t.docs} />
        <KpiCard label="Active users · 7d" value={t.activeUsers7d} sublabel={`${t.activeUsers30d} in 30d`} />
        <KpiCard label="AI calls (all time)" value={t.aiCallsAllTime} />
        <KpiCard label="Users with AI" value={t.usersWithAi} sublabel={`${aiPenetration}% of all users`} />
        <KpiCard label="Docs touched by AI" value={t.docsWithAi} sublabel={`${docsWithAiPct}% of all docs`} />
      </div>
    </section>
  );
}

function KpiCard({ label, value, sublabel }: { label: string; value: number; sublabel?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">
        {value.toLocaleString()}
      </div>
      {sublabel && <div className="mt-0.5 text-xs text-gray-500">{sublabel}</div>}
    </div>
  );
}

// ─── Activation funnel ────────────────────────────────────────────────

function FunnelSection({ stats }: { stats: AdminStats }) {
  const { usersSignedUp, usersWithEdits, usersWithAi } = stats.activationFunnel;
  const steps = [
    { label: "Signed up (≥1 doc)", n: usersSignedUp },
    { label: "Actually edited", n: usersWithEdits },
    { label: "Connected AI", n: usersWithAi },
  ];
  const maxN = Math.max(1, ...steps.map((s) => s.n));
  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Activation funnel
      </h2>
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-2.5">
        {steps.map((s, i) => {
          const pct = Math.round((s.n / maxN) * 100);
          const dropOffFromPrev =
            i === 0 || steps[i - 1].n === 0
              ? null
              : Math.round((s.n / steps[i - 1].n) * 100);
          return (
            <div key={s.label}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-gray-700">{s.label}</span>
                <span className="tabular-nums font-medium text-gray-900">
                  {s.n}
                  {dropOffFromPrev !== null && (
                    <span className="ml-2 text-xs text-gray-400">
                      {dropOffFromPrev}% of previous
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-[#0BA70B]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Daily activity ───────────────────────────────────────────────────

function DailySection({ stats }: { stats: AdminStats }) {
  // Render a compact bar stack per day. We pick the metric dimension with
  // the largest single-day value for scaling — keeps the chart honest even
  // when AI calls dominate human activity (or vice versa).
  const maxActiveUsers = Math.max(1, ...stats.daily.map((d) => d.activeUsers));
  const maxActiveDocs = Math.max(1, ...stats.daily.map((d) => d.activeDocs));
  const maxAi = Math.max(1, ...stats.daily.map((d) => d.aiCalls));

  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Daily activity ({stats.windowDays}d)
      </h2>
      <div className="bg-white border border-gray-200 rounded-lg p-4 overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-gray-400 text-left">
              <th className="font-normal pb-2">Date</th>
              <th className="font-normal pb-2 text-right">New users</th>
              <th className="font-normal pb-2 text-right">Active users</th>
              <th className="font-normal pb-2 text-right">New docs</th>
              <th className="font-normal pb-2 text-right">Active docs</th>
              <th className="font-normal pb-2 text-right">AI calls</th>
              <th className="font-normal pb-2 pl-3 w-48">Signal</th>
            </tr>
          </thead>
          <tbody>
            {stats.daily.map((d) => (
              <tr key={d.date} className="border-t border-gray-100">
                <td className="py-1.5 text-gray-600">{d.date.slice(5)}</td>
                <td className="py-1.5 text-right">{d.newUsers || ""}</td>
                <td className="py-1.5 text-right">{d.activeUsers || ""}</td>
                <td className="py-1.5 text-right">{d.newDocs || ""}</td>
                <td className="py-1.5 text-right">{d.activeDocs || ""}</td>
                <td className="py-1.5 text-right text-orange-600">{d.aiCalls || ""}</td>
                <td className="py-1.5 pl-3">
                  <div className="flex items-end gap-0.5 h-4">
                    <Sparkbar value={d.activeUsers} max={maxActiveUsers} color="bg-gray-500" />
                    <Sparkbar value={d.activeDocs} max={maxActiveDocs} color="bg-blue-500" />
                    <Sparkbar value={d.aiCalls} max={maxAi} color="bg-orange-500" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-[11px] text-gray-400 flex items-center gap-4">
          <LegendSwatch color="bg-gray-500" label="active users" />
          <LegendSwatch color="bg-blue-500" label="active docs" />
          <LegendSwatch color="bg-orange-500" label="AI calls" />
        </div>
      </div>
    </section>
  );
}

function Sparkbar({ value, max, color }: { value: number; max: number; color: string }) {
  const h = Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 16));
  return (
    <div
      className={`w-1.5 ${color} rounded-sm`}
      style={{ height: `${h}px` }}
      aria-hidden="true"
    />
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2.5 h-2.5 rounded-sm ${color}`} />
      {label}
    </span>
  );
}

// ─── Cohort retention ─────────────────────────────────────────────────

function CohortSection({ stats }: { stats: AdminStats }) {
  const { weeks, rows } = stats.cohorts;
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Weekly cohort retention
        </h2>
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-sm text-gray-400">
          Not enough history yet — check back in a week.
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Weekly cohort retention
      </h2>
      <div className="bg-white border border-gray-200 rounded-lg p-4 overflow-x-auto">
        <table className="text-xs tabular-nums">
          <thead>
            <tr className="text-gray-400">
              <th className="font-normal text-left pb-2 pr-3">Cohort</th>
              <th className="font-normal text-right pb-2 pr-4">Size</th>
              {weeks.map((_, i) => (
                <th key={i} className="font-normal text-center pb-2 px-1.5 w-12">
                  W{i === 0 ? "0" : `+${i}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => {
              const offset = rowIdx;
              return (
                <tr key={row.cohort} className="border-t border-gray-100">
                  <td className="py-1.5 pr-3 text-gray-600">{formatWeek(row.cohort)}</td>
                  <td className="py-1.5 pr-4 text-right text-gray-900 font-medium">
                    {row.size}
                  </td>
                  {weeks.map((_, colIdx) => {
                    if (colIdx < offset) {
                      return <td key={colIdx} className="py-1.5" />;
                    }
                    const n = row.retained[colIdx - offset] ?? 0;
                    const pct = row.size ? Math.round((n / row.size) * 100) : 0;
                    return (
                      <td key={colIdx} className="py-1.5 px-1 text-center">
                        <CohortCell n={n} pct={pct} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CohortCell({ n, pct }: { n: number; pct: number }) {
  if (n === 0) return <span className="text-gray-300">·</span>;
  // Saturation scales with retention %: more retained = darker green.
  const opacity = Math.max(0.08, Math.min(1, pct / 100));
  return (
    <div
      className="rounded py-1 text-center text-[11px] font-medium"
      style={{
        backgroundColor: `rgba(11, 167, 11, ${opacity})`,
        color: opacity > 0.5 ? "white" : "#0B4E0B",
      }}
      title={`${n} users · ${pct}%`}
    >
      {pct}%
    </div>
  );
}

function formatWeek(yyyyww: string): string {
  // "2026-16" → "'26 W16"
  const [yy, ww] = yyyyww.split("-");
  return `'${yy.slice(2)} W${ww}`;
}

// ─── Tool breakdown ───────────────────────────────────────────────────

function ToolBreakdown({ stats }: { stats: AdminStats }) {
  const total = stats.toolBreakdown.reduce((sum, x) => sum + x.count, 0);
  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        MCP tool calls ({stats.windowDays}d)
      </h2>
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        {stats.toolBreakdown.length === 0 ? (
          <p className="text-sm text-gray-400">No AI activity in this window.</p>
        ) : (
          <ul className="space-y-2.5">
            {stats.toolBreakdown.map((t) => {
              const pct = total ? Math.round((t.count / total) * 100) : 0;
              return (
                <li key={t.kind}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-mono text-gray-700">{t.kind.replace(/^mcp\./, "")}</span>
                    <span className="tabular-nums text-gray-900 font-medium">
                      {t.count}
                      <span className="ml-2 text-xs text-gray-400">{pct}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full bg-orange-500" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─── Top AI-active docs ───────────────────────────────────────────────

function TopDocs({ stats }: { stats: AdminStats }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Top docs by AI activity ({stats.windowDays}d)
      </h2>
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {stats.topDocs.length === 0 ? (
          <p className="text-sm text-gray-400 p-5">No AI-edited docs in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left text-xs">
                <th className="font-normal px-4 py-2">Doc</th>
                <th className="font-normal px-4 py-2">Owner</th>
                <th className="font-normal px-4 py-2 text-right">AI calls</th>
              </tr>
            </thead>
            <tbody>
              {stats.topDocs.map((d) => (
                <tr key={d.doc_id} className="border-t border-gray-100">
                  <td className="px-4 py-2">
                    <Link
                      href={`/doc/${d.doc_id}`}
                      className="text-gray-700 hover:text-black"
                    >
                      {d.title || "Untitled"}
                    </Link>
                    <span className="ml-2 text-[11px] text-gray-400 font-mono">
                      {d.doc_id}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 truncate max-w-[200px]">
                    {d.owner_id || "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {d.ai_calls}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
