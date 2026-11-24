import { handleSolveJob, type SolveJob, type SolveMessage } from './forecastSolve.ts';

// The background thread for "What your plan supports" and the scenario
// comparison (see solveDriver.ts). A solve is dozens of 1,000-path simulations;
// with bracket tax and Roth conversions on, one simulation alone takes a few
// hundred milliseconds, which on the page's own thread would freeze scrolling and
// typing for that long, again and again for several seconds. Here it blocks
// nothing. Pure computation on the inputs it is sent: no network, no storage.

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SolveJob>) => void) | null;
  postMessage: (m: SolveMessage) => void;
};
ctx.onmessage = e => handleSolveJob(e.data, m => ctx.postMessage(m));
