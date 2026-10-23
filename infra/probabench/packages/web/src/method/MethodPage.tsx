import "./method.css";

export function MethodPage() {
  return (
    <section>
      <header className="section-heading">
        <div>
          <p className="eyebrow">Behind the notebook</p>
          <h2>
            A simple question.
            <br />A careful measurement.
          </h2>
        </div>
        <p>
          A model can describe uncertainty fluently. Sampling from a probability is a different
          test.
        </p>
      </header>
      <div className="card method-steps">
        <article>
          <span className="step-number">01</span>
          <h3>Set a target.</h3>
          <p>
            Ask for the digit <code>1</code> with probability <var>x</var>, or <code>0</code>{" "}
            otherwise. Sweep the target from 0% through 100%.
          </p>
          <div className="method-equation">
            P(1) = <var>x</var>
          </div>
        </article>
        <article>
          <span className="step-number">02</span>
          <h3>Repeat the request.</h3>
          <p>
            Draw independent requests at each target. Keep the raw outcomes. Count invalid replies
            separately; they are never quietly treated as zeros.
          </p>
          <div className="method-equation mono-equation">0, 1, 0, …</div>
        </article>
        <article>
          <span className="step-number">03</span>
          <h3>Compare the frequency.</h3>
          <p>
            Plot the fraction of valid replies that are ones. A calibrated sampler follows the
            diagonal: a 30% target produces about 30% ones.
          </p>
          <div className="method-equation small-equation">observed ≈ target</div>
        </article>
      </div>
      <div className="method-notes">
        <article>
          <h3>Read the uncertainty.</h3>
          <p>
            Error bars are 95% Wilson intervals for the observed one-rate. They assume independent
            valid replies. Correlated responses, provider caches and small sample budgets can make
            that assumption imperfect.
          </p>
        </article>
        <article>
          <h3>Keep invalid replies in view.</h3>
          <p>
            A model that gives valid bits rarely can appear calibrated on the few replies that
            remain. Inspect the valid reply fraction and the number of targets with valid samples
            alongside the mean calibration gap.
          </p>
        </article>
        <article>
          <h3>Compare like with like.</h3>
          <p>
            The mean gap averages absolute frequency error across recorded targets with valid
            replies. Different target grids and sample budgets change what it measures. This
            notebook preserves run settings so those differences stay visible.
          </p>
        </article>
      </div>
    </section>
  );
}
