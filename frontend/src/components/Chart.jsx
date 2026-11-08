/* Time-series chart in SVG. X is seconds of the scenario, labelled relative to the job start. */
import { useLayoutEffect, useRef, useState } from "react";
import { clamp, fmt } from "../lib/format.js";

export default function Chart({ height = 220, duration, jobStart, yMin, yMax, unit, series = [], hlines = [], markers = [], cursor = null }) {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = 52, R = 12, T = 12, B = 26;
  const pw = w - L - R, ph = height - T - B;
  const X = (t) => L + (t / (duration - 1)) * pw;
  const Y = (v) => T + ph - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * ph;

  const ticks = [0, 1, 2, 3, 4].map((k) => yMin + ((yMax - yMin) * k) / 4);
  const xt = [];
  for (let t = jobStart % 60; t < duration; t += 60) xt.push(t);

  const path = (data, upTo) => {
    const n = Math.min(data.length, upTo ?? data.length);
    if (n < 2) return "";
    let d = "";
    for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(data[i]).toFixed(1)}`;
    return d;
  };
  const area = (data, upTo) => {
    const p = path(data, upTo);
    if (!p) return "";
    const n = Math.min(data.length, upTo ?? data.length);
    return `${p}L${X(n - 1).toFixed(1)},${T + ph}L${X(0)},${T + ph}Z`;
  };

  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} role="img">
        <defs>
          {series.filter((s) => s.fill).map((s) => (
            <linearGradient key={s.id} id={`g-${s.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.22" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        <g className="grid">
          {ticks.map((v) => <line key={v} x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} />)}
        </g>
        <g className="axis">
          {ticks.map((v) => <text key={v} x={L - 8} y={Y(v) + 3.5} textAnchor="end">{unit === "kW" ? fmt(v) : v}</text>)}
          {xt.map((t) => (
            <text key={t} x={X(t)} y={height - 6} textAnchor="middle">
              {t === jobStart ? "T+0" : `${t > jobStart ? "+" : "−"}${Math.abs(t - jobStart)}`}
            </text>
          ))}
        </g>
        <line x1={X(jobStart)} x2={X(jobStart)} y1={T} y2={T + ph} stroke="var(--ink-3)" strokeDasharray="2 4" />
        <text x={X(jobStart) + 6} y={T + 10} fill="var(--ink-3)" fontSize="10.5" fontFamily="var(--mono)">job start</text>
        {hlines.map((h) => (
          <g key={h.label}>
            <line x1={L} x2={w - R} y1={Y(h.y)} y2={Y(h.y)} stroke={h.color} strokeDasharray="3 4" strokeOpacity="0.8" />
            <text x={w - R - 4} y={Y(h.y) - 5} textAnchor="end" fill={h.color} fontSize="10.5" fontFamily="var(--mono)">{h.label}</text>
          </g>
        ))}
        {markers.filter((m) => cursor == null || m.t <= cursor).map((m, i) => (
          <g key={`${m.t}-${m.label}`}>
            <line x1={X(m.t)} x2={X(m.t)} y1={T} y2={T + ph} stroke={m.color} strokeOpacity="0.55" />
            <rect x={X(m.t) + 3} y={T + ph - 20 - (i % 3) * 16} width={m.label.length * 6.4 + 10} height="14" rx="2" fill={m.color} fillOpacity="0.16" />
            <text x={X(m.t) + 8} y={T + ph - 10 - (i % 3) * 16} fill={m.color} fontSize="10" fontFamily="var(--mono)">{m.label}</text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.id}>
            {s.fill && <path d={area(s.data, s.upTo)} fill={`url(#g-${s.id})`} />}
            <path d={path(s.data, s.upTo)} fill="none" stroke={s.color} strokeWidth={s.width || 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeOpacity={s.opacity ?? 1} />
          </g>
        ))}
        {cursor != null && cursor > 0 && cursor < duration - 1 && (
          <g>
            <line x1={X(cursor)} x2={X(cursor)} y1={T} y2={T + ph} stroke="var(--accent)" strokeOpacity="0.7" />
            <circle cx={X(cursor)} cy={T + ph} r="3" fill="var(--accent)" />
          </g>
        )}
      </svg>
    </div>
  );
}
