/* Alert tones. Browsers only allow audio after a user gesture, so call unlock() from a click. */
let ctx = null;
let muted = false;

export function unlock() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch { ctx = null; }
}
export const setMuted = (m) => { muted = m; };

export function tone(sev) {
  if (muted || !ctx) return;
  try {
    const n = sev === "crit" ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.2;
      o.type = sev === "crit" ? "square" : "sine";
      o.frequency.value = sev === "crit" ? 880 : sev === "warn" ? 660 : 520;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(sev === "crit" ? 0.06 : 0.05, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.18);
    }
  } catch { /* audio is best-effort */ }
}
