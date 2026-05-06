"use client";

import { useEffect, useRef, useState } from "react";

interface Contact {
  name: string;
  company: string;
  role: string;
  industry: string;
}

interface OutreachEntry {
  id: string;
  timestamp: string;
  week: string;
  medium: string;
  contact: Contact;
  summary: string;
  needs: string[];
  outcome: number;
  outcome_notes: string;
  follow_up: boolean;
  tags: string[];
}

const MEDIUM_COLORS: Record<string, string> = {
  phone: "#3b82f6",
  email: "#8b5cf6",
  linkedin: "#22c55e",
  physical: "#f59e0b",
  other: "#6b7280",
};

const MEDIUM_BG: Record<string, string> = {
  phone: "bg-blue-900/40 text-blue-300",
  email: "bg-purple-900/40 text-purple-300",
  linkedin: "bg-green-900/40 text-green-300",
  physical: "bg-amber-900/40 text-amber-300",
  other: "bg-gray-800 text-gray-400",
};

const OUTCOME_LABEL: Record<number, string> = {
  1: "Dead end",
  2: "Cold",
  3: "Neutral",
  4: "Positive",
  5: "Strong lead",
};

const OUTCOME_COLOR: Record<number, string> = {
  1: "text-red-400",
  2: "text-orange-400",
  3: "text-gray-400",
  4: "text-green-400",
  5: "text-emerald-400",
};

function currentISOWeek(): string {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const weekNum = Math.floor((now.getTime() - startOfWeek1.getTime()) / (7 * 86400000)) + 1;
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ── Minimal canvas bar chart ────────────────────────────────────────────────

function BarChart({ labels, values, colors }: { labels: string[]; values: number[]; colors: string | string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const padL = 28, padR = 8, padT = 8, padB = 32;
    const maxVal = Math.max(...values, 1);
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const barW = Math.max(4, chartW / values.length - 4);

    // Y gridlines
    ctx.strokeStyle = "#374151";
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((frac) => {
      const y = padT + chartH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    });

    values.forEach((val, i) => {
      const x = padL + (chartW / values.length) * i + (chartW / values.length - barW) / 2;
      const barH = (val / maxVal) * chartH;
      const y = padT + chartH - barH;
      ctx.fillStyle = Array.isArray(colors) ? colors[i] : colors;
      ctx.beginPath();
      const r = 3;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barW - r, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
      ctx.lineTo(x + barW, y + barH);
      ctx.lineTo(x, y + barH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();

      // label
      ctx.fillStyle = "#6b7280";
      ctx.font = `10px system-ui`;
      ctx.textAlign = "center";
      const labelText = labels[i].length > 7 ? labels[i].slice(-5) : labels[i];
      ctx.fillText(labelText, x + barW / 2, h - padB + 12);
    });

    // Y axis labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px system-ui";
    ctx.textAlign = "right";
    const step = Math.ceil(maxVal / 4);
    for (let v = 0; v <= maxVal; v += step) {
      const y = padT + chartH * (1 - v / maxVal);
      ctx.fillText(String(v), padL - 4, y + 3);
    }
  }, [labels, values, colors]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

function DonutChart({ labels, values, colors }: { labels: string[]; values: number[]; colors: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return;

    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.42;
    const innerR = size * 0.26;
    let angle = -Math.PI / 2;

    values.forEach((val, i) => {
      const sweep = (val / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx + outerR * Math.cos(angle), cy + outerR * Math.sin(angle));
      ctx.arc(cx, cy, outerR, angle, angle + sweep);
      ctx.arc(cx, cy, innerR, angle + sweep, angle, true);
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.fill();
      ctx.strokeStyle = "#030712";
      ctx.lineWidth = 2;
      ctx.stroke();
      angle += sweep;
    });

    ctx.fillStyle = "#9ca3af";
    ctx.font = `bold ${size * 0.14}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(total), cx, cy);
  }, [labels, values, colors]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function OutreachPage() {
  const [entries, setEntries] = useState<OutreachEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [mediumFilter, setMediumFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [followupFilter, setFollowupFilter] = useState("all");
  const [weekFilter, setWeekFilter] = useState("all");

  useEffect(() => {
    fetch("/api/public/outreach")
      .then((r) => r.json())
      .then((data) => {
        setEntries(Array.isArray(data) ? data.sort((a: OutreachEntry, b: OutreachEntry) => a.timestamp.localeCompare(b.timestamp)) : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const thisWeek = currentISOWeek();
  const allWeeks = [...new Set(entries.map((e) => e.week))].sort();

  const filtered = entries.filter((e) => {
    if (weekFilter !== "all" && e.week !== weekFilter) return false;
    if (mediumFilter !== "all" && e.medium !== mediumFilter) return false;
    if (outcomeFilter === "45" && e.outcome < 4) return false;
    if (outcomeFilter === "3" && e.outcome !== 3) return false;
    if (outcomeFilter === "12" && e.outcome > 2) return false;
    if (followupFilter === "yes" && !e.follow_up) return false;
    return true;
  });

  // Stats (unfiltered for top cards, except week filter for "this week")
  const thisWeekCount = entries.filter((e) => e.week === thisWeek).length;
  const outcomes = entries.map((e) => e.outcome).filter(Boolean);
  const avgOutcome = outcomes.length ? (outcomes.reduce((a, b) => a + b, 0) / outcomes.length).toFixed(1) : "—";
  const followupCount = entries.filter((e) => e.follow_up).length;

  // Chart data (use filtered)
  const weekCounts = allWeeks.map((w) => filtered.filter((e) => e.week === w).length);
  const mediums = ["phone", "email", "linkedin", "physical", "other"];
  const medCounts = mediums.map((m) => filtered.filter((e) => e.medium === m).length);
  const outcomeBins = [1, 2, 3, 4, 5];
  const outcomeCounts = outcomeBins.map((o) => filtered.filter((e) => e.outcome === o).length);
  const outcomeBarColors = ["#ef4444", "#f97316", "#6b7280", "#22c55e", "#16a34a"];

  const selectClass = "bg-gray-900 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-gray-500";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight">Outreach</h1>
        <span className="text-xs text-gray-500">{thisWeek}</span>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: "Total", value: entries.length, sub: `${allWeeks.length} week${allWeeks.length !== 1 ? "s" : ""}` },
                { label: "This Week", value: thisWeekCount, sub: thisWeek },
                { label: "Avg Outcome", value: avgOutcome, sub: "out of 5", color: "text-emerald-400" },
                { label: "Follow-ups", value: followupCount, sub: "pending", color: "text-amber-400" },
              ].map(({ label, value, sub, color }) => (
                <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</div>
                  <div className={`text-3xl font-bold tracking-tight ${color ?? ""}`}>{value}</div>
                  <div className="text-xs text-gray-600 mt-1">{sub}</div>
                </div>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1 bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-4">Per Week</h3>
                <div style={{ height: 160 }}>
                  <BarChart labels={allWeeks} values={weekCounts} colors="#3b82f6" />
                </div>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">By Medium</h3>
                <div className="flex items-center gap-4">
                  <div style={{ width: 100, height: 100, flexShrink: 0 }}>
                    <DonutChart
                      labels={mediums}
                      values={medCounts}
                      colors={mediums.map((m) => MEDIUM_COLORS[m])}
                    />
                  </div>
                  <div className="space-y-1.5">
                    {mediums.map((m, i) => medCounts[i] > 0 && (
                      <div key={m} className="flex items-center gap-2 text-xs">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: MEDIUM_COLORS[m] }} />
                        <span className="text-gray-400 capitalize">{m}</span>
                        <span className="text-gray-500 ml-auto">{medCounts[i]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-4">Outcomes</h3>
                <div style={{ height: 120 }}>
                  <BarChart labels={["1", "2", "3", "4", "5"]} values={outcomeCounts} colors={outcomeBarColors} />
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider">Entries</h3>
                <div className="flex items-center gap-2">
                  <select className={selectClass} value={weekFilter} onChange={(e) => setWeekFilter(e.target.value)}>
                    <option value="all">All weeks</option>
                    {allWeeks.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <select className={selectClass} value={mediumFilter} onChange={(e) => setMediumFilter(e.target.value)}>
                    <option value="all">All mediums</option>
                    {mediums.map((m) => <option key={m} value={m} className="capitalize">{m}</option>)}
                  </select>
                  <select className={selectClass} value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)}>
                    <option value="all">All outcomes</option>
                    <option value="45">Positive (4–5)</option>
                    <option value="3">Neutral (3)</option>
                    <option value="12">Cold (1–2)</option>
                  </select>
                  <select className={selectClass} value={followupFilter} onChange={(e) => setFollowupFilter(e.target.value)}>
                    <option value="all">All</option>
                    <option value="yes">Follow-up needed</option>
                  </select>
                </div>
              </div>

              {filtered.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-10">No entries.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800 bg-gray-950/50">
                      <th className="text-left px-5 py-2.5">Date</th>
                      <th className="text-left px-5 py-2.5">Medium</th>
                      <th className="text-left px-5 py-2.5">Contact</th>
                      <th className="text-left px-5 py-2.5">Summary</th>
                      <th className="text-left px-5 py-2.5">Needs</th>
                      <th className="text-left px-5 py-2.5">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...filtered].reverse().map((e) => (
                      <tr key={e.id} className="border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                        <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">
                          {new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${MEDIUM_BG[e.medium] ?? MEDIUM_BG.other}`}>
                            {e.medium}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="font-medium text-gray-200">{e.contact?.name || "—"}</div>
                          <div className="text-xs text-gray-500">
                            {[e.contact?.company, e.contact?.role].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-gray-400 text-xs max-w-xs truncate">{e.summary}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(e.needs || []).map((n, i) => (
                              <span key={i} className="text-xs bg-blue-950/60 text-blue-400 px-1.5 py-0.5 rounded">{n}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`font-semibold ${OUTCOME_COLOR[e.outcome] ?? "text-gray-400"}`}>
                              {e.outcome}
                            </span>
                            <span className="text-xs text-gray-600">{OUTCOME_LABEL[e.outcome]}</span>
                            {e.follow_up && (
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Follow-up needed" />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
