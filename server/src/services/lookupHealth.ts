// A running count of market lookups that came back WITHOUT a real answer: a
// throttle, an outage, a network error. Each provider module swallows such a
// failure and returns something lesser (no holdings, an empty price series, a
// stale figure), which is right for one request but must not be mistaken for
// the truth by anything that keeps the result. storedResult.ts compares the
// count before and after a computation: if it moved, the result was built on a
// failed lookup, is kept only briefly, and never replaces a good copy.
//
// "The provider has no such symbol" is an answer, not a failure, and is not
// counted here.
let failures = 0;

export function noteLookupFailure(): void { failures++; }

export function lookupFailureCount(): number { return failures; }
