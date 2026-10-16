// Written for the tests, not by uvp.
//
// Stands in for a container runtime that is only ever asked who it is. It prints
// the banner and exits, whatever it was handed — a real runtime would go on to
// start a container, and the test that installs this one intercepts every
// container command through the provider's `run` seam, so nothing here has to
// describe what a container would have done.
//
// On Windows this file never runs for `--version`: Node answers that itself,
// before any JavaScript, so the banner a copied Node prints is its own version.
// The test measures what the tool announced rather than asserting this string,
// which is what keeps the claim — the provider reports what the runtime said —
// true on both hosts.
console.log("uvp-container-shim 1.0.0");
