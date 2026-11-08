import { lineSpan } from "../lib/format.js";

/** Traceability tag: rule id + the source lines it came from. Clicking opens it in the Rules view. */
export function Trace({ id, lines, onClick }) {
  const inner = (<><b>{id}</b>{lines && lines[0] > 0 && <span>{lineSpan(lines)}</span>}</>);
  return onClick
    ? <button type="button" className="trace" onClick={onClick} title={`Open rule ${id} and its source lines`}>{inner}</button>
    : <span className="trace">{inner}</span>;
}

export function PageHead({ n, eyebrow, dim, title, children, right }) {
  return (
    <div className="pagehead anim-in">
      <div style={{ flex: 1, minWidth: 300 }}>
        <div className="eyebrow section"><span className="n">{n}</span>{eyebrow}</div>
        <h1 style={{ marginTop: 12 }}>{dim && <span className="dim">{dim}</span>}{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {right}
    </div>
  );
}
