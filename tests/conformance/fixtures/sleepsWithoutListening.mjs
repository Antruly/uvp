// Written for the tests, not by uvp.
//
// A process that starts and stays alive without listening on anything. The
// readiness probe therefore expires while the child is still there, which
// `uvp_run` has to report as a bound that was reached — not as an exit it never
// observed, and not as a service that is up.
setTimeout(() => {}, 60_000);
