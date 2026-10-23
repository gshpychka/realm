export function EmptyNotebook({
  onNew,
  onMethod,
}: {
  /** Absent on the published site, which cannot run benchmarks. */
  onNew: (() => void) | undefined;
  onMethod: () => void;
}) {
  return (
    <section className="card empty-notebook">
      <h2>Start with one model.</h2>
      <p>
        Choose a model, collect its samples, and see how closely it follows the probabilities you
        ask for. Each run becomes part of the history.
      </p>
      <div className="empty-actions">
        {onNew ? (
          <button type="button" className="button primary" onClick={onNew}>
            New benchmark <span aria-hidden="true">↗</span>
          </button>
        ) : null}
        <button type="button" className="text-button" onClick={onMethod}>
          Read the method <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}
