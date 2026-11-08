/* Toasts plus a notification centre (bell). Every toast is also kept in the bell history,
   so an operator who looked away can see what fired. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { tone } from "../lib/audio.js";

const Ctx = createContext(null);
export const useNotify = () => useContext(Ctx);

let seq = 0;

export function NotificationProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [notes, setNotes] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    ({ sev = "info", title, body = "", actions = [], sticky = false, pulse = false, silent = false, at = "", key }) => {
      const id = ++seq;
      if (!silent) tone(sev);
      setToasts((ts) => {
        let next = [{ id, sev, title, body, actions, sticky, pulse, key }, ...ts.filter((t) => !key || t.key !== key)];
        if (next.length > 4) {
          const victim = [...next].reverse().find((t) => !t.sticky) || next[next.length - 1];
          next = next.filter((t) => t !== victim);
        }
        return next;
      });
      setNotes((ns) => [{ id, sev, title, body, at, read: false }, ...ns].slice(0, 60));
      if (!sticky) timers.current[id] = setTimeout(() => dismiss(id), sev === "warn" ? 9000 : 6500);
      return id;
    },
    [dismiss],
  );

  const dismissKey = useCallback((key) => setToasts((ts) => ts.filter((t) => t.key !== key)), []);
  const patchKey = useCallback((key, patch) => setToasts((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t))), []);
  const clearToasts = useCallback(() => setToasts([]), []);
  const markRead = useCallback(() => setNotes((ns) => ns.map((n) => ({ ...n, read: true }))), []);
  const clearNotes = useCallback(() => setNotes([]), []);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const value = { notify, dismiss, dismissKey, patchKey, clearToasts, notes, markRead, clearNotes };
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.sev}${t.pulse ? " pulse" : ""}`} role={t.sev === "crit" ? "alert" : "status"}>
            <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <div className="tt">{t.title}</div>
              <button className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
            </div>
            {t.body && <div className="tb">{t.body}</div>}
            {t.countdown && <div className="cd">{t.countdown}</div>}
            {t.actions?.length > 0 && (
              <div className="ta">
                {t.actions.map((a) => (
                  <button key={a.label} className={`btn sm ${a.cls || ""}`} onClick={() => { a.fn(); if (!a.keep) dismiss(t.id); }}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function Bell() {
  const { notes, markRead, clearNotes } = useNotify();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const unread = notes.filter((n) => !n.read).length;

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  return (
    <div ref={ref}>
      <button
        className="iconbtn"
        id="bell"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open) markRead(); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="bellpanel">
          <div className="row" style={{ padding: "2px 6px 10px" }}>
            <span className="eyebrow">Notifications</span>
            <span className="sp" />
            <button className="btn sm ghost" onClick={clearNotes}>Clear</button>
          </div>
          {notes.length === 0 && <p className="faint small" style={{ padding: "10px 6px" }}>Nothing yet. Alerts from a live run collect here.</p>}
          {notes.map((n) => (
            <div key={n.id} className={`note ${n.sev}${n.read ? " read" : ""}`}>
              <span className="d" />
              <div>
                <b>{n.title}</b>
                {n.body && <span className="muted">{n.body}</span>}
                {n.at && <div><time>{n.at}</time></div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
