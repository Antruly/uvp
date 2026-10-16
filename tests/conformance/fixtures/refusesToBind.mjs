// Written for the tests, not by uvp.
//
// Stands in for a built service that cannot start: it says why on stderr and
// exits non-zero, the way a program does when the port it was told to bind is
// gone. `uvp_run` has to report that as a service that did not come up rather
// than as a readiness timeout, and the text is what the caller reads, so the
// assertion is on what this prints.
process.stderr.write("cannot bind\n");
process.exit(3);
