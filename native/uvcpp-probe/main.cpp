/**
 * uvcpp-probe: one WebSocket exchange, driven through libuvcpp's C ABI.
 *
 * uvp's own WebSocket probe speaks WebSocket from Node. That is a real check of
 * the service on the other end, but it is a check made by a *different*
 * implementation than the one a generated service links: two clients that agree
 * on RFC 6455 can disagree on everything the RFC leaves open, and a uvp-generated
 * `websocket-echo` answering a Node client says nothing about whether libuvcpp's
 * own client stack can talk to it. This program exists so that question can be
 * asked: it links libuvcpp and drives the exchange through `uvcpp_c_ws_client`,
 * which is libuvcpp's WebSocket client reaching the wire.
 *
 * Four shape decisions, all of them about being able to trust what comes back:
 *
 *   - **It is a process, not an addon.** A native addon would run inside the MCP
 *     server, where a hang in C++ is a hang in the tool, and a crash takes the
 *     session with it. Here a hang is a child process that a timeout kills, and
 *     a crash is an exit code.
 *   - **It ends itself rather than asking the loop to stop.** `stop()` is the
 *     only call the C ABI allows from a thread that is not the loop's, and on
 *     this stack it sets a flag and does not wake anything: `uv_stop` cannot
 *     interrupt a loop that is already blocked in `poll`, and this client's loop
 *     has nothing else to wake it — no timer, no async handle, no `post`. So a
 *     peer that goes quiet leaves `run()` blocked indefinitely, and `stop()` only
 *     takes effect if something else wakes the loop first (a frame arriving, or
 *     the peer closing). A probe promises a bounded runtime, so a deadline that
 *     passes ends the process: the report is written from the watchdog and
 *     `run()` is left where it is. `abandoned` in the report says so, and says
 *     why the closing handshake in it is missing.
 *   - **It reports only what it saw.** The C ABI does not expose the upgrade
 *     response's status line or headers, so this program cannot report them, and
 *     the fields are absent rather than guessed at. Same for request headers:
 *     `uvcpp_c_ws_client_connect` takes a URL and nothing else.
 *   - **It decides nothing about what a frame means.** This program reports the
 *     frames it observed and the order they arrived in; whether any of them
 *     answers a caller's question is not asked here. The caller's own probe
 *     answers that, once, for both stacks — and a second matcher in this file
 *     would be a second rule about which frames count, sitting where nobody
 *     looking at the caller would find it.
 *
 * Protocol: one JSON object on stdin, one JSON object on stdout, nothing else on
 * stdout ever. Diagnostics go to stderr. Exit code 0 means "a report was
 * produced" — including a report that says the connection was refused, which is
 * an observation and not a failure. Exit code 2 means the request could not be
 * read, and exit code 3 means this program could not run (a header/library ABI
 * mismatch). Both of those print a JSON object too, with `error` set, so a caller
 * that parses stdout never has to fall back to reading an exit code it did not
 * expect.
 */

#include <capi/uvcpp_c.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

constexpr int kExitOk = 0;
constexpr int kExitBadRequest = 2;
constexpr int kExitCannotRun = 3;

/** How often the watchdog looks at the clock. Only timeouts are affected. */
constexpr int kWatchdogIntervalMs = 20;
/**
 * How long `run()` is given to return after `stop()` before it is left behind.
 *
 * It is not expected to — see the note at the top of this file. It is here for
 * the one case where something does wake the loop in the moment after a deadline:
 * then a frame, or a close, that the peer sent at the end of the exchange is
 * still reported instead of being lost to a process exit.
 */
constexpr int kStopGraceMs = 150;
/** How long to wait for the peer's answering close frame before giving up. */
constexpr int kCloseGraceMs = 250;

constexpr int kDefaultIdleMs = 1'500;
constexpr int kDefaultTotalTimeoutMs = 20'000;
constexpr int kDefaultMaxFrames = 200;
constexpr size_t kDefaultMaxFrameBytes = 65536;

/** The close code uvp's own probe sends, so the two stacks behave the same. */
constexpr int kCloseCode = 1000;

long long millisecondsSince(const Clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}

/**
 * Is this a valid UTF-8 sequence?
 *
 * Checked rather than assumed because the answer decides whether a payload can be
 * reported as `text` at all: JSON cannot carry a byte that is not valid UTF-8, and
 * a received "text" frame holding invalid bytes is a protocol violation the caller
 * should hear about rather than see silently repaired.
 */
bool isValidUtf8(const char* data, size_t length) {
  const auto* bytes = reinterpret_cast<const unsigned char*>(data);
  size_t index = 0;
  while (index < length) {
    const unsigned char lead = bytes[index];
    size_t extra = 0;
    uint32_t code_point = 0;
    if (lead < 0x80) {
      index += 1;
      continue;
    } else if ((lead & 0xE0) == 0xC0) {
      extra = 1;
      code_point = lead & 0x1Fu;
    } else if ((lead & 0xF0) == 0xE0) {
      extra = 2;
      code_point = lead & 0x0Fu;
    } else if ((lead & 0xF8) == 0xF0) {
      extra = 3;
      code_point = lead & 0x07u;
    } else {
      return false;
    }
    if (index + extra >= length) return false;
    for (size_t offset = 1; offset <= extra; ++offset) {
      const unsigned char continuation = bytes[index + offset];
      if ((continuation & 0xC0) != 0x80) return false;
      code_point = (code_point << 6) | (continuation & 0x3Fu);
    }
    // Overlong encodings, surrogates, and out-of-range code points are not UTF-8
    // even though the byte pattern above accepts them.
    if (extra == 1 && code_point < 0x80) return false;
    if (extra == 2 && code_point < 0x800) return false;
    if (extra == 3 && code_point < 0x10000) return false;
    if (code_point > 0x10FFFF) return false;
    if (code_point >= 0xD800 && code_point <= 0xDFFF) return false;
    index += extra + 1;
  }
  return true;
}

/**
 * Base64, so a binary frame reads the same way it does from uvp's own probe.
 *
 * uvp's Node-side probe reports a binary payload as `base64`, and a second stack
 * that reported only a byte count would make the same frame look like less
 * information than it is.
 */
std::string base64Encode(const char* data, size_t length) {
  static constexpr char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const auto* bytes = reinterpret_cast<const unsigned char*>(data);
  std::string out;
  out.reserve(((length + 2) / 3) * 4);
  for (size_t index = 0; index < length; index += 3) {
    const uint32_t first = bytes[index];
    const uint32_t second = index + 1 < length ? bytes[index + 1] : 0;
    const uint32_t third = index + 2 < length ? bytes[index + 2] : 0;
    const uint32_t group = (first << 16) | (second << 8) | third;
    out.push_back(kAlphabet[(group >> 18) & 0x3F]);
    out.push_back(kAlphabet[(group >> 12) & 0x3F]);
    out.push_back(index + 1 < length ? kAlphabet[(group >> 6) & 0x3F] : '=');
    out.push_back(index + 2 < length ? kAlphabet[group & 0x3F] : '=');
  }
  return out;
}

struct FrameRecord {
  std::string direction;
  std::string opcode;
  size_t bytes = 0;
  long long at_ms = 0;
  bool truncated = false;
  bool has_text = false;
  std::string text;
  /** Set for a binary frame: the payload, encoded, so a caller can read it. */
  std::string base64;
  /** Why `text` is absent on a text frame: truncation or invalid encoding. */
  std::string text_omitted;
};

struct SendSpec {
  bool binary = false;
  std::string payload;
  /** Honoured only if zero: see the refusal in `parseOptions`. */
  int wait_ms = 0;
};

struct Options {
  std::string url;
  std::vector<SendSpec> send;
  int idle_ms = kDefaultIdleMs;
  int total_timeout_ms = kDefaultTotalTimeoutMs;
  int max_frames = kDefaultMaxFrames;
  size_t max_frame_bytes = kDefaultMaxFrameBytes;
};

/**
 * Everything one probe run knows.
 *
 * Two threads are alive for most of a run — the client's loop and the watchdog —
 * and because a deadline has this program write the report out from under a loop
 * that is still running, they really do share this. `mu` guards every field the
 * loop thread writes: the frame log, the handshake result, the close the peer
 * sent. The atomics below it are the ones the watchdog reads on a timer, where
 * taking a lock twenty times a second to read one number would be the only thing
 * it ever did.
 */
struct Run {
  Options options;
  Clock::time_point started;

  std::mutex mu;
  std::vector<FrameRecord> frames;
  size_t frames_withheld = 0;
  size_t frames_received = 0;
  bool opened = false;
  bool handshake_done = false;
  bool peer_closed = false;
  int peer_close_code = 0;
  std::string peer_close_reason;
  bool errored = false;
  int error_code = 0;
  std::string error_what;
  /** "" | "idle" | "total" — which deadline ended the run. */
  std::string stop_reason;
  /** True when the report was written without `run()` ever returning. */
  bool abandoned = false;
  /** `run()`'s own return value: reported, never interpreted. See `main`. */
  int loop_return = 0;
  long long total_ms = 0;

  std::atomic<long long> last_activity_ms{0};
  std::atomic<bool> stopped{false};
  std::atomic<bool> close_sent{false};
  std::atomic<long long> close_sent_at_ms{-1};
  std::atomic<bool> loop_returned{false};
  std::atomic<bool> report_claimed{false};
};

uvcpp_c_ws_client* g_client = nullptr;
Run* g_run = nullptr;

void requestStop(Run& run, const char* kind) {
  if (run.stopped.exchange(true)) return;
  if (g_client != nullptr) uvcpp_c_ws_client_stop(g_client);
  if (kind != nullptr && kind[0] != '\0') {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.stop_reason = kind;
  }
}

void recordFrame(Run& run, const std::string& direction, const std::string& opcode,
                 const char* data, size_t length) {
  run.last_activity_ms.store(millisecondsSince(run.started));
  if (direction == "received") run.frames_received += 1;
  if (run.frames.size() >= static_cast<size_t>(run.options.max_frames) + run.options.send.size()) {
    // Counted, not dropped silently: a frame log that stops early without saying
    // so reads as "that is all the peer sent".
    run.frames_withheld += 1;
    return;
  }
  FrameRecord frame;
  frame.direction = direction;
  frame.opcode = opcode;
  frame.bytes = length;
  frame.at_ms = millisecondsSince(run.started);
  const size_t kept = length > run.options.max_frame_bytes ? run.options.max_frame_bytes : length;
  frame.truncated = kept < length;
  if (opcode == "binary") {
    frame.base64 = base64Encode(data, kept);
  } else if (opcode == "text") {
    if (frame.truncated) {
      frame.text_omitted = "truncated";
    } else if (isValidUtf8(data, length)) {
      frame.has_text = true;
      frame.text.assign(data, length);
    } else {
      // A text frame that is not UTF-8 is a violation by the peer. Passed on as
      // such rather than replaced with substitution characters, which would look
      // like the server sent something it did not.
      frame.text_omitted = "invalid-utf8";
    }
  }
  run.frames.push_back(std::move(frame));
}

/**
 * Send the closing handshake, once.
 *
 * Sent when the received-frame cap is reached: there is nothing more this probe
 * was asked to look at, and a peer whose close code is the answer is more likely
 * to give it to a client that closes than to one that vanishes.
 *
 * What that gives up is the peer's reply. `close()` ends the session on this
 * stack rather than starting a closing handshake — `run()` comes back at once and
 * nothing the peer sends afterwards is observable — so closing earlier, while
 * there was still something to read, would throw those frames away. That is why a
 * probe with nothing to send does not close at all, and why `not_observable`
 * lists the answer to a close this probe sent.
 */
void sendClose(Run& run) {
  if (run.close_sent.exchange(true)) return;
  if (g_client == nullptr) return;
  const long long now = millisecondsSince(run.started);
  run.close_sent_at_ms.store(now);
  uvcpp_c_ws_client_close(g_client, kCloseCode, "");
  run.last_activity_ms.store(now);
}

/** Queue the frames the caller asked for. Returns true when one was refused. */
bool sendQueuedFrames(Run& run) {
  for (const SendSpec& spec : run.options.send) {
    const int status =
        spec.binary ? uvcpp_c_ws_client_send_binary(g_client, spec.payload.data(),
                                                    spec.payload.size())
                    : uvcpp_c_ws_client_send_text(g_client, spec.payload.data(),
                                                  spec.payload.size());
    if (status != 0) {
      const std::lock_guard<std::mutex> lock(run.mu);
      run.errored = true;
      run.error_code = status;
      const char* name = uvcpp_c_strerror(status);
      run.error_what = std::string("the client refused to queue a frame: ") +
                       (name == nullptr ? std::to_string(status) : name);
      return true;
    }
    // Recorded under the lock and sent outside it: the loop thread never calls
    // into the library while holding this, so a callback invoked from inside one
    // of those calls cannot find the lock already held by its own thread.
    const std::lock_guard<std::mutex> lock(run.mu);
    recordFrame(run, "sent", spec.binary ? "binary" : "text", spec.payload.data(),
                spec.payload.size());
  }
  return false;
}

void onStatus(void* /*user_data*/, int status) {
  Run& run = *g_run;
  bool failed = false;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.handshake_done = true;
    run.last_activity_ms.store(millisecondsSince(run.started));
    if (status != 0) {
      // No HTTP status and no response headers here: the C ABI reports that the
      // handshake failed and what the transport said, which is all it knows.
      run.errored = true;
      run.error_code = status;
      run.error_what = "the WebSocket handshake did not complete";
      failed = true;
    } else {
      run.opened = true;
    }
  }
  if (failed) {
    requestStop(run, nullptr);
    return;
  }
  // Frames go out here because this is the first moment a session exists. A probe
  // that was given nothing to send sends nothing: on this stack `close()` is the
  // end of the run rather than the start of a closing handshake, so closing
  // because there is nothing left to send would discard the greeting — and with
  // it the answer to "did the far end say anything". It listens instead, until
  // the peer or a deadline ends the run.
  if (sendQueuedFrames(run)) requestStop(run, nullptr);
}

void onText(void* /*user_data*/, const char* data, size_t length) {
  Run& run = *g_run;
  bool enough = false;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    recordFrame(run, "received", "text", data, length);
    enough = run.frames_received >= static_cast<size_t>(run.options.max_frames);
  }
  if (enough) sendClose(run);
}

void onBinary(void* /*user_data*/, const char* data, size_t length) {
  Run& run = *g_run;
  bool enough = false;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    recordFrame(run, "received", "binary", data, length);
    enough = run.frames_received >= static_cast<size_t>(run.options.max_frames);
  }
  if (enough) sendClose(run);
}

void onClose(void* /*user_data*/, int code, const char* reason, size_t reason_len) {
  Run& run = *g_run;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.peer_closed = true;
    run.peer_close_code = code;
    if (reason != nullptr && reason_len > 0 && isValidUtf8(reason, reason_len)) {
      run.peer_close_reason.assign(reason, reason_len);
    }
    run.last_activity_ms.store(millisecondsSince(run.started));
  }
  // A session that has ended leaves the loop with nothing left to do, so this
  // wakes it as well as stopping it.
  requestStop(run, nullptr);
}

void onError(void* /*user_data*/, int status, const char* what, size_t what_len) {
  Run& run = *g_run;
  const std::lock_guard<std::mutex> lock(run.mu);
  run.errored = true;
  if (run.error_code == 0) run.error_code = status;
  run.error_what.assign(what == nullptr ? "" : std::string(what, what_len));
  run.last_activity_ms.store(millisecondsSince(run.started));
}

json frameJson(const FrameRecord& frame) {
  json out = {
      {"direction", frame.direction},
      {"opcode", frame.opcode},
      {"bytes", frame.bytes},
      {"at_ms", frame.at_ms},
      {"truncated", frame.truncated},
  };
  if (frame.has_text) out["text"] = frame.text;
  if (!frame.base64.empty()) out["base64"] = frame.base64;
  if (!frame.text_omitted.empty()) out["text_omitted"] = frame.text_omitted;
  return out;
}

/** The report, from a run whose fields are settled. The caller holds `mu`. */
json reportFrom(const Run& run) {
  json frames = json::array();
  for (const FrameRecord& frame : run.frames) frames.push_back(frameJson(frame));
  json out = {
      {"probe", "uvcpp-capi"},
      {"abi_version", static_cast<int>(uvcpp_c_abi_version())},
      {"library_version",
       uvcpp_c_version_string() == nullptr ? "" : uvcpp_c_version_string()},
      {"url", run.options.url},
      {"opened", run.opened},
      {"handshake_completed", run.handshake_done},
      {"frames", frames},
      {"frames_received", run.frames_received},
      {"frames_withheld", run.frames_withheld},
      {"close_sent_by_probe", run.close_sent.load()},
      {"peer_closed", run.peer_closed},
      {"error", run.error_what.empty()
                    ? json(nullptr)
                    : json({{"what", run.error_what}, {"code", run.error_code}})},
      {"stop_reason", run.stop_reason.empty() ? json(nullptr) : json(run.stop_reason)},
      {"total_ms", run.total_ms},
      // Said once, here, because it is a property of the stack and not of this
      // run: what the C ABI cannot see, this probe cannot report.
      {"not_observable",
       json::array({"the upgrade response's status line and headers",
                    "the negotiated subprotocol", "ping and pong frames",
                    "request headers or subprotocols supplied by the caller",
                    "pacing a send after the previous one",
                    "the peer's answer to a close this probe sent"})},
  };
  if (run.peer_closed) {
    out["close"] = {{"code", run.peer_close_code}, {"reason", run.peer_close_reason}};
  }
  if (run.loop_return != 0) out["loop_return"] = run.loop_return;
  // Present when the report was written without `run()` ever returning, which is
  // how a run a deadline ends ordinarily finishes here: `stop()` cannot wake a
  // loop parked in `poll`, so the report goes out from under it. Whatever the peer
  // sent after the last frame above was never read, and a caller reading a log
  // that stops has to be able to tell that from a connection that went quiet.
  if (run.abandoned) out["abandoned"] = true;
  return out;
}

/** Write the report and flush it: `_Exit`, which may follow, does not flush. */
void emitReport(Run& run, bool abandoned) {
  json out;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.abandoned = abandoned;
    run.total_ms = millisecondsSince(run.started);
    out = reportFrom(run);
  }
  std::cout << out.dump() << "\n";
  std::cout.flush();
}

/**
 * End the run from the watchdog.
 *
 * Returns true when the run was given up on — `run()` did not come back, so the
 * caller has to write the report itself — and false when the loop ended after all
 * (a callback stopped it, or a late frame woke it), in which case writing the
 * report is the loop thread's to do.
 */
bool endRun(Run& run, const char* reason) {
  if (run.stopped.exchange(true)) return false;
  // Best effort, and why it is not enough on its own is at the top of this file:
  // the flag is set, but a loop blocked in `poll` will not look at it until
  // something else wakes it.
  if (g_client != nullptr) uvcpp_c_ws_client_stop(g_client);
  if (reason != nullptr && reason[0] != '\0') {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.stop_reason = reason;
  }
  const auto grace_until = Clock::now() + std::chrono::milliseconds(kStopGraceMs);
  while (!run.loop_returned.load() && Clock::now() < grace_until) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kWatchdogIntervalMs));
  }
  return !run.loop_returned.load();
}

/**
 * End the run when the exchange goes quiet, when the peer has had long enough to
 * answer a close, or when the whole thing has taken too long.
 *
 * Nothing here sends: `send_text` and `close` belong to the loop thread, and the C
 * ABI rejects them anywhere else. So a run that ends on a deadline ends without a
 * closing handshake, and the report says so.
 */
void watch(Run& run) {
  while (true) {
    std::this_thread::sleep_for(std::chrono::milliseconds(kWatchdogIntervalMs));
    if (run.stopped.load()) return;
    const long long now = millisecondsSince(run.started);
    const char* reason = nullptr;
    if (now >= run.options.total_timeout_ms) {
      reason = "total";
    } else if (run.close_sent.load() && now - run.close_sent_at_ms.load() >= kCloseGraceMs) {
      reason = "";
    } else if (now - run.last_activity_ms.load() >= run.options.idle_ms) {
      reason = "idle";
    }
    if (reason == nullptr) continue;
    if (!endRun(run, reason)) return;
    if (run.report_claimed.exchange(true)) return;
    // The loop is left running, so what it has recorded up to this instant is all
    // there is. The flag is re-read here rather than trusted from the check above,
    // because `run()` can come back in the moment between the two and a report
    // that claims the loop was abandoned when it was not would be wrong about why
    // there is no closing handshake in it.
    emitReport(run, !run.loop_returned.load());
    std::_Exit(kExitOk);
  }
}

void emit(const json& value) {
  std::cout << value.dump() << "\n";
  std::cout.flush();
}

int fail(int code, const std::string& message) {
  emit(json({{"probe", "uvcpp-capi"}, {"error", {{"what", message}}}}));
  std::cerr << "uvcpp-probe: " << message << "\n";
  return code;
}

Options parseOptions(const json& request) {
  Options options;
  options.url = request.value("url", "");
  options.idle_ms = request.value("idle_ms", kDefaultIdleMs);
  options.total_timeout_ms = request.value("total_timeout_ms", kDefaultTotalTimeoutMs);
  options.max_frames = request.value("max_frames", kDefaultMaxFrames);
  options.max_frame_bytes = request.value("max_frame_bytes", kDefaultMaxFrameBytes);
  for (const json& entry : request.value("send", json::array())) {
    SendSpec spec;
    if (entry.contains("binary_base64")) {
      spec.binary = true;
      spec.payload = entry.at("binary_base64").get<std::string>();
    } else {
      spec.payload = entry.value("text", "");
    }
    spec.wait_ms = entry.value("wait_ms", 0);
    options.send.push_back(std::move(spec));
  }
  return options;
}

}  // namespace

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);

  if (argc > 1 && std::strcmp(argv[1], "--version") == 0) {
    // The availability probe: it proves this binary runs, and it reports the ABI
    // it was built against so a caller can tell a mismatch from a missing file.
    emit(json({{"probe", "uvcpp-capi"},
               {"abi_version", static_cast<int>(uvcpp_c_abi_version())},
               {"header_abi_version", static_cast<int>(UVCPP_C_ABI_VERSION)},
               {"library_version",
                uvcpp_c_version_string() == nullptr ? "" : uvcpp_c_version_string()}}));
    return uvcpp_c_abi_version() == UVCPP_C_ABI_VERSION ? kExitOk : kExitCannotRun;
  }

  // Header and library version first: everything below assumes the two agree,
  // and a mismatch here is the failure mode with no useful symptom.
  if (uvcpp_c_abi_version() != static_cast<unsigned int>(UVCPP_C_ABI_VERSION)) {
    return fail(kExitCannotRun,
                "this probe was built against C ABI version " +
                    std::to_string(UVCPP_C_ABI_VERSION) + " and the library it loaded reports " +
                    std::to_string(uvcpp_c_abi_version()));
  }

  json request;
  try {
    std::cin >> request;
  } catch (const std::exception& error) {
    return fail(kExitBadRequest, std::string("the request is not one JSON object: ") + error.what());
  }
  if (!request.is_object()) return fail(kExitBadRequest, "the request is not a JSON object");

  Run run;
  run.options = parseOptions(request);
  if (run.options.url.empty()) return fail(kExitBadRequest, "the request has no url");
  if (run.options.idle_ms <= 0 || run.options.total_timeout_ms <= 0 ||
      run.options.idle_ms > run.options.total_timeout_ms) {
    return fail(kExitBadRequest,
                "idle_ms must be positive and no larger than total_timeout_ms");
  }
  if (run.options.max_frames <= 0) return fail(kExitBadRequest, "max_frames must be positive");
  for (const SendSpec& spec : run.options.send) {
    if (spec.wait_ms != 0) {
      // Refused rather than ignored. The C ABI hands the WebSocket client a loop
      // and no way to schedule work on it — there is no timer and no `post` on
      // this handle — so a paced send can only be done by sleeping on the loop
      // thread, which would stop the client reading frames for exactly the
      // interval it was asked to pace over. Answering with a run that quietly
      // sent everything at once would make the two stacks disagree about the
      // same request while looking like they agreed.
      return fail(kExitBadRequest,
                  "wait_ms between sends is not something the libuvcpp C ABI can do: the "
                  "WebSocket client exposes no timer or post on its loop");
    }
  }
  run.started = Clock::now();

  uvcpp_c_ws_client* client = uvcpp_c_ws_client_new();
  if (client == nullptr) return fail(kExitCannotRun, "uvcpp_c_ws_client_new failed");
  g_client = client;
  g_run = &run;

  uvcpp_c_ws_client_events events{};
  events.size = static_cast<uint32_t>(sizeof(events));
  events.on_text = onText;
  events.on_binary = onBinary;
  events.on_close = onClose;
  events.on_error = onError;
  if (uvcpp_c_ws_client_set_events(client, &events, nullptr) != UVCPP_C_OK) {
    uvcpp_c_ws_client_free(client);
    g_client = nullptr;
    return fail(kExitCannotRun, "uvcpp_c_ws_client_set_events failed");
  }

  const int connected = uvcpp_c_ws_client_connect(client, run.options.url.c_str(), onStatus, nullptr);
  if (connected != UVCPP_C_OK) {
    // A URL the C ABI will not accept is the caller's request being wrong, not an
    // observation about the server.
    uvcpp_c_ws_client_free(client);
    g_client = nullptr;
    const char* name = uvcpp_c_strerror(connected);
    return fail(kExitBadRequest,
                std::string("uvcpp_c_ws_client_connect rejected ") + run.options.url + ": " +
                    (name == nullptr ? std::to_string(connected) : name));
  }

  std::thread watchdog(watch, std::ref(run));
  const int ran = uvcpp_c_ws_client_run(client);
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.loop_return = ran;
  }
  run.loop_returned.store(true);
  // The watchdog has either returned (the run ended here) or is about to end the
  // process, in which case this join never comes back.
  watchdog.join();

  if (!run.report_claimed.exchange(true)) {
    // `run()`'s return value is reported, not interpreted: the C ABI documents no
    // meaning for it, and it is not one of the error codes. A negative value that
    // this layer *can* name is one of its error codes, and is reported as an
    // error; anything else goes out as the number it is, under `loop_return`.
    // Turning an unnamed number into a failure would be this program claiming
    // something the library never claimed.
    if (ran < 0) {
      const char* name = uvcpp_c_strerror(ran);
      if (name != nullptr) {
        const std::lock_guard<std::mutex> lock(run.mu);
        if (run.error_what.empty()) {
          run.errored = true;
          run.error_code = ran;
          run.error_what = std::string("the client loop ended with ") + name;
        }
      }
    }
    emitReport(run, false);
  }

  uvcpp_c_ws_client_free(client);
  g_client = nullptr;
  g_run = nullptr;
  return kExitOk;
}
