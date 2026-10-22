import { Rx } from "@effect-rx/rx-react";
import { loadResults } from "./results";

// Reactive cell holding the fetch+decode of /data/results.json as a Result
// (Initial → Success | Failure), consumed in the UI via useRxValue.
export const resultsRx = Rx.make(loadResults);
