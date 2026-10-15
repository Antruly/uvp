/**
 * The WebSocket exchange: one `uvcpp_c_ws_client` session, reported as frames.
 *
 * uvp's own WebSocket probe speaks WebSocket from Node. That is a real check of
 * the service on the other end, but it is a check made by a *different*
 * implementation than the one a generated service links: two clients that agree
 * on RFC 6455 can disagree on everything the RFC leaves open, and a uvp-generated
 * `websocket-echo` answering a Node client says nothing about whether libuvcpp's
 * own client stack can talk to it. This is the half of the probe that asks.
 *
 * Two shape decisions:
 *
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
 * The ending, the protocol, and the refusals are shared with the h3 exchange and
 * live in `probe.h`.
 */

#include "probe.h"

#include <capi/uvcpp_c.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace probe {
namespace {

constexpr int kDefaultIdleMs = 1'500;
constexpr int kDefaultTotalTimeoutMs = 20'000;
constexpr int kDefaultMaxFrames = 200;
constexpr size_t kDefaultMaxFrameBytes = 65536;

/** How long to wait for the peer's answering close frame before giving up. */
constexpr int kCloseGraceMs = 250;

/** The close code uvp's own probe sends, so the two stacks behave the same. */
constexpr int kCloseCode = 1000;

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
  /** Honoured only if zero: see the refusal in `runWebSocket`. */
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
 * The session in flight, for the C callbacks, which take no user data of their
 * own beyond what `_set_events` and `_connect` were given.
 *
 * Declared before `Run` because `Run::stopClient` names the client.
 */
struct Run;

/**
 * The two handles the callbacks reach for. Declared before `Run` because
 * `Run::stopClient` names the client, and before the struct's definition because a
 * pointer to an incomplete type is all either of them needs.
 */
uvcpp_c_ws_client* g_client = nullptr;
Run* g_run = nullptr;

/**
 * Everything one run knows.
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
  int idle_ms = kDefaultIdleMs;
  int total_timeout_ms = kDefaultTotalTimeoutMs;

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
  bool abandoned = false;
  /** `run()`'s own return value: reported, never interpreted. See `runWebSocket`. */
  int loop_return = 0;
  long long total_ms = 0;

  std::atomic<long long> last_activity_ms{0};
  std::atomic<bool> stopped{false};
  std::atomic<bool> close_sent{false};
  std::atomic<long long> close_sent_at_ms{-1};
  std::atomic<bool> loop_returned{false};
  std::atomic<bool> report_claimed{false};

  void touch() { last_activity_ms.store(millisecondsSince(started)); }

  void stopClient() {
    if (g_client != nullptr) uvcpp_c_ws_client_stop(g_client);
  }

  /** The one deadline this exchange has beyond the two shared ones. */
  const char* extraStopReason(long long now) const {
    if (close_sent.load() && now - close_sent_at_ms.load() >= kCloseGraceMs) return "";
    return nullptr;
  }

  void writeReport(bool was_abandoned);
};

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
  run.touch();
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
    run.touch();
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
    run.touch();
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
  run.touch();
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
      {"exchange", "websocket"},
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

void Run::writeReport(bool was_abandoned) {
  json out;
  {
    const std::lock_guard<std::mutex> lock(mu);
    abandoned = was_abandoned;
    total_ms = millisecondsSince(started);
    out = reportFrom(*this);
  }
  emit(out);
}

}  // namespace

int runWebSocket(const json& request) {
  Run run;
  run.options.url = request.value("url", "");
  run.options.idle_ms = request.value("idle_ms", kDefaultIdleMs);
  run.options.total_timeout_ms = request.value("total_timeout_ms", kDefaultTotalTimeoutMs);
  run.options.max_frames = request.value("max_frames", kDefaultMaxFrames);
  run.options.max_frame_bytes = request.value("max_frame_bytes", kDefaultMaxFrameBytes);
  for (const json& entry : request.value("send", json::array())) {
    SendSpec spec;
    if (entry.contains("binary_base64")) {
      spec.binary = true;
      spec.payload = entry.at("binary_base64").get<std::string>();
    } else {
      spec.payload = entry.value("text", "");
    }
    spec.wait_ms = entry.value("wait_ms", 0);
    run.options.send.push_back(std::move(spec));
  }
  run.idle_ms = run.options.idle_ms;
  run.total_timeout_ms = run.options.total_timeout_ms;
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

  std::thread watchdog(watch<Run>, std::ref(run));
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
    run.writeReport(false);
  }

  uvcpp_c_ws_client_free(client);
  g_client = nullptr;
  g_run = nullptr;
  return kExitOk;
}

}  // namespace probe
