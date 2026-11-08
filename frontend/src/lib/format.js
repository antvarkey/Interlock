export const fmt = (n, d = 0) =>
  n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const lineSpan = (l) => (l[0] === l[1] ? `L${l[0]}` : `L${l[0]}–${l[1]}`);

/** Time relative to the job start, the way operators talk about it: T−30 s, T+12 s. */
export const rel = (t, jobStart) => (t < jobStart ? `T−${jobStart - t}s` : `T+${t - jobStart}s`);

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
