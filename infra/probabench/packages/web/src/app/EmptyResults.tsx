export function EmptyResults({
  onNew,
  onMethod,
}: {
  /** Absent on the published site, which cannot run benchmarks. */
  onNew: (() => void) | undefined;
  onMethod: () => void;
}) {
  return (
    <section className="card empty-results">
      <h2>No results yet</h2>
      <p>Run a benchmark to collect answers for the graph.</p>
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
