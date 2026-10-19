// Written for the tests, not by uvp.
//
// A process that ends by signal rather than by an exit code. `uvp_run` has to
// report that as `exit_signal: "SIGTERM"` with a null `exit_code` — the null is
// the observation that there was no code, not a value that failed to arrive.
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 5_000);
