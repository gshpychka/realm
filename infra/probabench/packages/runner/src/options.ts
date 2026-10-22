import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** A rejected run configuration, before any samples or provider credentials are read. */
export class InvalidOptions extends Data.TaggedError("InvalidOptions")<{
  readonly message: string;
}> {}

export interface SamplingOptions {
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
}

export const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidOptions({ message: `${name} must be a positive safe integer.` });
  }
  return value;
};

export const probabilityStep = (value: number): number => {
  positiveInteger(value, "step");
  if (value > 100) throw new InvalidOptions({ message: "step must be between 1 and 100 percent." });
  return value;
};

/** Always include both endpoints, including when the step does not divide 100. */
export const probabilityPercentages = (step: number): readonly number[] => {
  probabilityStep(step);
  return [...Array.from({ length: Math.ceil(100 / step) }, (_, index) => index * step), 100];
};

export const validateSamplingOptions = (
  options: SamplingOptions,
): Effect.Effect<void, InvalidOptions> =>
  Effect.try({
    try: () => {
      positiveInteger(options.trialsPerStep, "trials");
      probabilityStep(options.stepPercent);
      positiveInteger(options.concurrency, "concurrency");
      positiveInteger(
        options.trialsPerStep * probabilityPercentages(options.stepPercent).length,
        "sample count",
      );
    },
    catch: (error) =>
      error instanceof InvalidOptions ? error : new InvalidOptions({ message: String(error) }),
  });
