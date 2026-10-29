import "./method.css";

export function MethodPage() {
  return (
    <article className="method-page" aria-labelledby="method-title">
      <header>
        <h2 id="method-title">How it works</h2>
        <p>
          Ask a language model to answer either <code>0</code> or <code>1</code>, and to choose{" "}
          <code>1</code> a specified percentage of the time. If you ask for 30%, about 30 out of
          every 100 answers should be <code>1</code>. ProbaBench repeats the request many times and
          counts what the model actually returns.
        </p>
      </header>

      <section>
        <h3>What the model is asked</h3>
        <p>Each request starts a new conversation with this instruction:</p>
        <pre className="method-prompt">
          <code>
            You are a random bit generator. On each call you output exactly one character — the
            digit 1 or the digit 0 — and nothing else: no words, no punctuation, no explanation.
          </code>
        </pre>
        <p>It then gives the model the percentage to use. For example:</p>
        <pre className="method-prompt">
          <code>Output 1 with probability 30%, otherwise 0.</code>
        </pre>
        <p>
          The same task is repeated at percentages from 0% to 100%. Requests go through OpenRouter.
          The model and its reasoning setting are saved with the answers; temperature and other
          sampling controls use the provider’s defaults.
        </p>
      </section>

      <section>
        <h3>How answers are counted</h3>
        <p>
          A reply counts if it is exactly <code>0</code> or <code>1</code> after removing whitespace
          at the ends. Other replies, including empty answers, are saved as invalid and excluded
          from the percentage calculation.
        </p>
        <p>
          If a model returns 30 ones, 60 zeros and 10 invalid answers, its observed percentage of
          ones is 30 ÷ 90 = 33.3%. Collecting more answers adds them to the existing totals for that
          model, reasoning setting and requested percentage.
        </p>
      </section>

      <section>
        <h3>What the graphs show</h3>
        <p>
          The main graph compares the requested percentage of ones with the percentage actually
          returned. This requested percentage is called the target. A point on the diagonal means
          the two percentages match. Points above it mean too many ones; points below it mean too
          few.
        </p>
        <p>
          Mean absolute error (MAE) is the average absolute difference between requested and
          observed percentages. Asking for 30% and getting 40% gives an error of 10 percentage
          points. Lower is better. Each requested percentage with valid answers has equal weight.
          Percentages with no valid answers are left out.
        </p>
        <p>
          The optional bars show 95% Wilson confidence intervals: a range expressing the uncertainty
          from having a limited number of answers. They assume independent answers; repeated or
          correlated responses can make them too narrow. The measurement tables show the counts
          behind each point.
        </p>
        <p>
          The history graph tracks mean absolute error. Each point includes all answers collected by
          that date. Click a point to see the measurements at that time. Changes can reflect more
          answers, a different set of requested percentages, or changes to the model or provider.
        </p>
      </section>
    </article>
  );
}
