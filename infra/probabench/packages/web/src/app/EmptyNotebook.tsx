/** The y = x diagonal a calibrated sampler follows, drawn in the page's own type. */
function ReferenceSketch() {
  return (
    <svg viewBox="0 0 160 100" fill="none" aria-hidden="true">
      <path d="M22 10V80H150" stroke="currentColor" opacity=".25" />
      <path d="M22 80L143 14" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 5" />
      <text x="17" y="97" fill="currentColor" fontSize="8" fontFamily="var(--mono)">
        0
      </text>
      <text x="143" y="97" fill="currentColor" fontSize="8" fontFamily="var(--mono)">
        1
      </text>
      <text
        x="80"
        y="33"
        fill="currentColor"
        fontSize="12"
        fontFamily="var(--serif)"
        fontStyle="italic"
      >
        y = x
      </text>
    </svg>
  );
}

export function EmptyNotebook({ onNew, onMethod }: { onNew: () => void; onMethod: () => void }) {
  return (
    <section className="card empty-notebook" role="status">
      <div className="empty-sketch">
        <ReferenceSketch />
      </div>
      <h2>Start with one model.</h2>
      <p>
        Choose a model, collect its samples, and see how closely it follows the probabilities you
        ask for. Each run becomes part of the history.
      </p>
      <div className="empty-actions">
        <button type="button" className="button primary" onClick={onNew}>
          New benchmark <span aria-hidden="true">↗</span>
        </button>
        <button type="button" className="text-button" onClick={onMethod}>
          Read the method <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}
