/* INTERLOCK wordmark: white Inter Tight caps with the "O" drawn as a cooling fan.
   The fan doubles as a status light: it turns while the cooling loop runs, turns faster
   when chiller 2 is helping, and stops when the loop has tripped. */

export function Fan({ size = 18, mode = "idle", title }) {
  return (
    <svg
      className={`fan fan-${mode}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <circle cx="12" cy="12" r="10.6" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <g className="blades" fill="currentColor">
        {[0, 90, 180, 270].map((a) => (
          <path key={a} transform={`rotate(${a} 12 12)`} d="M13.2 10.6C13.4 7.4 15.4 4.9 17.9 5.4c1.2 2.6-.6 5.8-3.4 6.9Z" />
        ))}
        <circle cx="12" cy="12" r="2.2" />
      </g>
      <circle cx="12" cy="12" r="0.9" fill="var(--bg)" />
    </svg>
  );
}

export default function Logo({ fanMode = "idle" }) {
  return (
    <div className="logo" aria-label="Interlock">
      <span aria-hidden="true">INTERL</span>
      <Fan mode={fanMode} />
      <span aria-hidden="true">CK</span>
    </div>
  );
}
