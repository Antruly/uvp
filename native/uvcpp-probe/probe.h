/**
 * What the probe's two exchanges have in common.
 *
 * uvcpp-probe answers two questions about a service uvp generated: "can
 * libuvcpp's own WebSocket client talk to it" and "can libuvcpp's own HTTP/3
 * client fetch from it". They are different exchanges over different transports
 * with different reports, so they are different translation units — but they are
 * one program, and three things about it are the same for both and must not be
 * written twice:
 *
 *   - **The protocol.** One JSON request on stdin, one JSON report on stdout,
 *     nothing else on stdout ever, diagnostics on stderr. Exit 0 means a report
 *     was produced; exit 2 means the request could not be read, and exit 3 means
 *     this program could not run. Both of the latter print a report too, so a
 *     caller that reads stdout never has to fall back to an exit code it did not
 *     expect.
 *   - **The watchdog.** The C ABI's clients own their loops and offer no way to
 *     wake one from another thread: `stop()` sets a flag, and a loop already
 *     parked in `poll` will not look at it until something else wakes it. So a
 *     deadline that passes ends this *process*, with the report written from the
 *     watchdog and `run()` left where it is — reported as `abandoned`, because
 *     whatever the peer sent after the last recorded fact was never read. That is
 *     a subtle thing to get right once; twice would be two chances to get it
 *     wrong in the same file.
 *   - **The refusals.** A request this program cannot serve is refused in the
 *     caller's words rather than answered with a run of a *different* request.
 *
 * The watchdog is a template over the run type rather than two functions over a
 * pair of parallel structs: each exchange's run state carries its own fields and
 * implements the small set of members below, and there is exactly one copy of the
 * ending logic. See `watch()` for what those members are.
 */

#pragma once

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>

namespace probe {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

constexpr int kExitOk = 0;
constexpr int kExitBadRequest = 2;
constexpr int kExitCannotRun = 3;

/** How often the watchdog looks at the clock. Only timeouts are affected. */
constexpr int kWatchdogIntervalMs = 20;

/**
 * How long a loop is given to return after it has been asked to stop, before it
 * is left behind.
 *
 * It is not expected to — see the note above. It is here for the one case where
 * something does wake the loop in the moment after a deadline: then a fact the
 * peer sent at the end of the exchange is still reported instead of being lost to
 * a process exit.
 */
constexpr int kStopGraceMs = 150;

/** Milliseconds since a run began, on the run's own clock. */
long long millisecondsSince(Clock::time_point start);

/**
 * Is this a valid UTF-8 sequence?
 *
 * Checked rather than assumed because the answer decides whether a payload can be
 * reported as `text` at all: JSON cannot carry a byte that is not valid UTF-8, and
 * a received payload holding invalid bytes is a protocol violation the caller
 * should hear about rather than see silently repaired.
 */
bool isValidUtf8(const char* data, size_t length);

/** Base64, so a binary payload reads as itself rather than as a byte count. */
std::string base64Encode(const char* data, size_t length);

/** One report, on stdout, flushed: `_Exit`, which may follow, does not flush. */
void emit(const json& value);

/**
 * Refuse a request, in the caller's words.
 *
 * The message goes to stderr as well as into the report, because on a refusal
 * that sentence is the whole value of the run.
 */
int fail(int code, const std::string& message);

/**
 * Watch one run and end it when it has gone on long enough.
 *
 * Returns when the run ended on its own (a callback stopped it, or the loop
 * returned). Otherwise it writes the report itself and ends the process, because
 * a loop that cannot be woken cannot write anything.
 *
 * `Run` is whichever of the two exchange states this is, and it has to provide:
 *
 *   - `started`, `idle_ms`, `total_timeout_ms` — when the run began, and the two
 *     deadlines, both in milliseconds.
 *   - `last_activity_ms` (`std::atomic<long long>`) — touched by every callback
 *     that observed something, so "quiet" means "the far end said nothing".
 *   - `stopped`, `loop_returned`, `report_claimed` (`std::atomic<bool>`) — the
 *     three flags that make ending a run happen exactly once.
 *   - `stop_reason` (a `std::string` guarded by `mu`) and `mu` — why it ended.
 *   - `stopClient()` — asks the transport to stop, loop-thread rules permitting.
 *   - `extraStopReason(now)` — an exchange-specific deadline that has passed, or
 *     nullptr. The WebSocket exchange ends a run shortly after sending its own
 *     close frame; the h3 exchange has nothing beyond the two deadlines.
 *   - `writeReport(abandoned)` — writes the report, from the watchdog's thread.
 */
template <typename Run>
void watch(Run& run) {
  while (true) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kWatchdogIntervalMs));
    if (run.stopped.load()) return;
    const long long now = millisecondsSince(run.started);
    const char* reason = nullptr;
    if (now >= run.total_timeout_ms) {
      reason = "total";
    } else if (const char* extra = run.extraStopReason(now)) {
      reason = extra;
    } else if (now - run.last_activity_ms.load() >= run.idle_ms) {
      reason = "idle";
    }
    if (reason == nullptr) continue;

    if (run.stopped.exchange(true)) return;
    run.stopClient();
    if (reason != nullptr && reason[0] != '\0') {
      const std::lock_guard<std::mutex> lock(run.mu);
      run.stop_reason = reason;
    }
    const auto grace_until = Clock::now() + std::chrono::milliseconds(kStopGraceMs);
    while (!run.loop_returned.load() && Clock::now() < grace_until) {
      std::this_thread::sleep_for(std::chrono::milliseconds(kWatchdogIntervalMs));
    }
    if (run.loop_returned.load()) return;
    if (run.report_claimed.exchange(true)) return;
    // The loop is left running, so what it has recorded up to this instant is all
    // there is. The flag is re-read here rather than trusted from the check above,
    // because `run()` can come back in the moment between the two and a report
    // that claims the loop was abandoned when it was not would be wrong about why
    // nothing after the last fact is in it.
    run.writeReport(true);
    std::_Exit(kExitOk);
  }
}

}  // namespace probe
