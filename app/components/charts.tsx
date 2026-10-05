"use client";

// Small hand-rolled SVG charts (single series, so no legend: the card title names it).
// Hover shows a crosshair + tooltip; hit areas are wider than the marks.

import { useEffect, useRef, useState } from "react";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const fmtNum = (v: number, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });

const M = { top: 12, right: 12, bottom: 26, left: 44 };

// ---- Today: power over the day ----------------------------------------------

export function DayLine({ points, unit = "W", startMs, endMs }: { points: [number, number][]; unit?: string; startMs: number; endMs: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const yMax = niceMax(Math.max(...points.map((p) => p[1]), 0));
  const x = (t: number) => M.left + ((t - startMs) / (endMs - startMs)) * iw;
  const y = (v: number) => M.top + ih - (v / yMax) * ih;

  // Break the line where the collector was offline (> 5 min gap).
  const segments: [number, number][][] = [];
  for (const p of points) {
    const seg = segments[segments.length - 1];
    if (seg && p[0] - seg[seg.length - 1][0] <= 5 * 60_000) seg.push(p);
    else segments.push([p]);
  }
  const line = (s: [number, number][]) => s.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = (s: [number, number][]) => `${line(s)}L${x(s[s.length - 1][0]).toFixed(1)},${y(0)}L${x(s[0][0]).toFixed(1)},${y(0)}Z`;

  const ticksY = [0, yMax / 2, yMax];
  const hours = [0, 6, 12, 18, 24];
  const hp = hover != null ? points[hover] : null;
  const last = points[points.length - 1];

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!points.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = startMs + ((e.clientX - r.left) / r.width) * (endMs - startMs);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
    setHover(best);
  }

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={`Solar output today, peak ${fmtNum(Math.max(0, ...points.map((p) => p[1])))} ${unit}`}>
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--magenta)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticksY.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} className={v === 0 ? "axis" : "grid"} />
            <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="tick">{v >= 1000 ? `${fmtNum(v / 1000, 1)}k` : fmtNum(v)}</text>
          </g>
        ))}
        {hours.map((h) => (
          <text key={h} x={x(startMs + h * 3600_000)} y={height - 6} textAnchor={h === 0 ? "start" : h === 24 ? "end" : "middle"} className="tick">
            {h === 0 || h === 24 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}
          </text>
        ))}
        {segments.map((s, i) => (
          <g key={i}>
            <path d={area(s)} className="area" />
            <path d={line(s)} className="line" />
          </g>
        ))}
        {last && !hp && <circle cx={x(last[0])} cy={y(last[1])} r={4} className="dot" />}
        {hp && (
          <g>
            <line x1={x(hp[0])} x2={x(hp[0])} y1={M.top} y2={y(0)} className="crosshair" />
            <circle cx={x(hp[0])} cy={y(hp[1])} r={4} className="dot" />
          </g>
        )}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hp[0]), 70), width - 70), top: 0 }}>
          <strong>{fmtNum(hp[1])} {unit}</strong>
          <span>{new Date(hp[0]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
        </div>
      )}
    </div>
  );
}

// ---- Bars: daily / monthly energy ----------------------------------------------

// marker: a benchmark value drawn as a short line across that bar (e.g. expected production).
export type Bar = { key: string; label: string; value: number; tick?: string; highlight?: boolean; marker?: number };
export type Reference = { value: number; label: string };

export function Bars({ bars, unit, digits = 1, height = 200, reference, markerLabel }: { bars: Bar[]; unit: string; digits?: number; height?: number; reference?: Reference; markerLabel?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const yMax = niceMax(Math.max(...bars.map((b) => Math.max(b.value, b.marker ?? 0)), reference?.value ?? 0, 0));
  const band = iw / Math.max(bars.length, 1);
  const bw = Math.min(24, Math.max(2, band - 2)); // 2px surface gap between touching bars
  const y = (v: number) => M.top + ih - (v / yMax) * ih;
  const r = Math.min(4, bw / 2);
  const hb = hover != null ? bars[hover] : null;

  // Column with a rounded top and a square base.
  const col = (cx: number, v: number) => {
    const top = y(v), base = y(0), x0 = cx - bw / 2, x1 = cx + bw / 2;
    if (base - top < r) return `M${x0},${base}V${top}H${x1}V${base}Z`;
    return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`;
  };

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={`${bars.length} bars, max ${fmtNum(Math.max(0, ...bars.map((b) => b.value)), digits)} ${unit}`}>
        <defs>
          <linearGradient id="bar-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--magenta)" />
            <stop offset="100%" stopColor="var(--purple)" />
          </linearGradient>
        </defs>
        {[0, yMax / 2, yMax].map((v) => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} className={v === 0 ? "axis" : "grid"} />
            <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="tick">{fmtNum(v, yMax < 1 ? 2 : yMax < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = M.left + band * (i + 0.5);
          return (
            <g key={b.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              {b.value > 0 && <path d={col(cx, b.value)} className={b.highlight ? "bar bar-accent" : hover === i ? "bar bar-hover" : "bar"} />}
              <rect x={cx - band / 2} y={M.top} width={band} height={ih} fill="transparent" />
              {b.marker != null && b.marker > 0 && <line x1={cx - bw / 2 - 3} x2={cx + bw / 2 + 3} y1={y(b.marker)} y2={y(b.marker)} className="marker" />}
              {b.tick && <text x={cx} y={height - 6} textAnchor="middle" className="tick">{b.tick}</text>}
            </g>
          );
        })}
        {reference && (
          <g className="reference">
            <line x1={M.left} x2={width - M.right} y1={y(reference.value)} y2={y(reference.value)} />
          </g>
        )}
      </svg>
      {(markerLabel || reference) && (
        <div className="legend">
          <span><i className="key-bar" /> Actual</span>
          {markerLabel && <span><i className="key-marker" /> {markerLabel}</span>}
          {reference && <span><i className="key-ref" /> {reference.label}</span>}
        </div>
      )}
      {hb && (
        <div className="tooltip" style={{ left: Math.min(Math.max(M.left + band * (hover! + 0.5), 70), width - 70), top: 0 }}>
          <strong>{fmtNum(hb.value, digits)} {unit}</strong>
          {hb.marker != null && <span>{markerLabel ?? "Expected"}: {fmtNum(hb.marker, digits)} {unit} ({Math.round((hb.value / hb.marker) * 100)}%)</span>}
          <span>{hb.label}</span>
        </div>
      )}
    </div>
  );
}
