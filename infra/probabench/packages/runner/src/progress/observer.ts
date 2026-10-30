import * as Context from "effect/Context";

export interface AdmissionStatus {
  readonly active: number;
  readonly limit: number;
  readonly blockedUntil: number;
}

export interface SchedulerStatus extends AdmissionStatus {
  readonly models: ReadonlyMap<string, AdmissionStatus & { readonly queued: number }>;
}

export interface SamplingObserver {
  readonly scheduler: (read: () => SchedulerStatus) => void;
  readonly started: (model: string, retry: boolean) => void;
  readonly ended: (model: string) => void;
  readonly received: (model: string, cost: number | null) => void;
  readonly saved: (model: string, invalid: boolean) => void;
  readonly finished: (model: string, error?: string) => void;
}

/** Observation never participates in request admission or checkpoint ownership. */
export class SamplingProgress extends Context.Reference<SamplingProgress>()(
  "probabench/SamplingProgress",
  {
    defaultValue: (): SamplingObserver => ({
      scheduler: () => {},
      started: () => {},
      ended: () => {},
      received: () => {},
      saved: () => {},
      finished: () => {},
    }),
  },
) {}
