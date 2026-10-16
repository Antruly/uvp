// Written for the tests, not by uvp.
//
// Stands in for a tool that succeeds at whatever it is asked and says nothing —
// which is what `/bin/true` was in the fixture this replaced. A provider that
// runs `cmake -S . -B build` only reads the exit code and the output, so this is
// enough to take a workspace through the parts of a build that are about the
// provider rather than about CMake.
//
// It is reached two ways, and both are the same to this file: on Unix it is the
// script's own program, and on Windows it is imported by the preload that
// `NODE_OPTIONS` names (see `tests/support/fakeExecutable.ts`). Nothing may be
// printed here: the test that uses it asserts that the configure step's output
// is empty of diagnostics.
process.exit(0);
