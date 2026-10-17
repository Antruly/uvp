/**
 * The HTTP/3 exchange: one request over QUIC, reported as a response.
 *
 * The other half of the probe, and the only way uvp can ask an HTTP/3 question at
 * all. Node has no HTTP/3 client, so `uvp http --http-version 3` cannot be
 * answered by the same in-process client that answers 1.1 and 2 — and answering it
 * with "not supported" would leave the one transport uvp can *generate* a service
 * for as the one it cannot observe. libuvcpp's C ABI has an h3 client, so this
 * program drives it.
 *
 * Five things about this stack shape the code below:
 *
 *   - **The crypto backend is initialized by hand, before anything else.**
 *     `uvcpp_c_quic_crypto_init()` is what makes the `EVP_*` implementations
 *     ngtcp2's OpenSSL backend needs. Nothing checks that it ran: a QUIC handshake
 *     without it fails *halfway*, with no error on any callback and no connection
 *     — which is exactly what the first attempt at this program did, and why the
 *     comment is here rather than only in the manual. This program serves one
 *     request per process, so "once, before any QUIC object" and "here" are the
 *     same place.
 *   - **The h3 connection is built in one narrow window.** `_h3_connection_new`
 *     takes a borrowed connection handle, and on a client the only moment it may be
 *     called is after `_connect()` returns and before the loop is pumped again.
 *   - **Nothing may be installed on the QUIC connection afterwards.** Not the ALPN
 *     callback, not anything else: `_conn_start()` replaces the whole QUIC callback
 *     table with h3's own, and the QUIC header says plainly that installing a table
 *     after that tears half of h3's driver out — the symptom being requests that go
 *     out and are never answered, rather than an error code. So the ALPN is *read*
 *     (`_conn_alpn_selected`) rather than pushed, and the loop polls.
 *   - **The loop is polled, not run.** `_run_once()` is `UV_RUN_NOWAIT`, which is
 *     what makes "wait until the critical streams exist, then send" writable at
 *     all; the h3 layer has no ready callback to hang the send off. The cost is
 *     that timings here are as coarse as the poll interval, which the report says.
 *   - **`on_disconnect` must free the h3 connection.** The h3 object does not own
 *     the QUIC connection; when that ends the h3 object has no footing, and the
 *     library leaves destroying it to its holder.
 *
 * What it cannot see, it does not report: the C ABI exposes response headers by
 * name, so only the names in `kReportedHeaders` can be looked for, and the report
 * says so rather than letting a short header list read as a complete one.
 */

#include "probe.h"

#include <capi/uvcpp_c.h>
#include <capi/uvcpp_c_http3.h>
#include <capi/uvcpp_c_quic.h>

#include <cstdint>
#include <string>
#include <vector>

namespace probe {
namespace {

constexpr int kDefaultIdleMs = 5'000;
constexpr int kDefaultTotalTimeoutMs = 20'000;
constexpr size_t kDefaultMaxBodyBytes = 65536;

/** How long the poll loop sleeps between rounds. It is also the timing floor. */
constexpr int kPollIntervalMs = 2;

/**
 * The response headers this program asks for, by name.
 *
 * The C ABI reads one header at a time (`_response_header`), so a complete header
 * list is not something this stack can produce at any price. The choice is between
 * naming the headers a caller of an HTTP tool would look for and reporting none —
 * and reporting none would make `uvp http --http-version 3` the only version whose
 * output has no `content-type`. What is *not* in this list is named as unobserved
 * in the report rather than passed over in silence.
 */
constexpr const char* kReportedHeaders[] = {
    "content-type",      "content-length", "server",   "date",
    "location",          "cache-control",  "etag",     "last-modified",
    "vary",              "allow",          "content-encoding",
    "transfer-encoding", "set-cookie",
};

struct Header {
  std::string name;
  std::string value;
};

struct Options {
  std::string url;
  std::string host;
  int port = 0;
  std::string path;
  std::string authority;
  std::string method = "GET";
  std::string body;
  std::string ca_file;
  std::vector<Header> headers;
  int idle_ms = kDefaultIdleMs;
  int total_timeout_ms = kDefaultTotalTimeoutMs;
  size_t max_body_bytes = kDefaultMaxBodyBytes;
};

/**
 * The two handles the callbacks reach for. Declared before `Run` because
 * `Run::stopClient` names the client.
 */
uvcpp_c_quic_client* g_client = nullptr;
uvcpp_c_h3_connection* g_h3 = nullptr;

/**
 * One run's state, shared between the loop thread and the watchdog.
 *
 * `mu` guards everything the loop thread writes — the handshake result, the ALPN,
 * the response. The atomics below it are what the watchdog reads on a timer, where
 * taking a lock twenty times a second to read one number would be the only thing it
 * ever did.
 */
struct Run {
  Options options;
  Clock::time_point started;
  int idle_ms = kDefaultIdleMs;
  int total_timeout_ms = kDefaultTotalTimeoutMs;

  std::mutex mu;
  bool handshake_done = false;
  bool handshake_ok = false;
  int handshake_status = 0;
  std::string alpn;
  bool request_sent = false;
  int64_t stream_id = -1;
  int send_attempts = 0;
  int last_send_error = 0;
  bool answered = false;
  int status = 0;
  int response_error = 0;
  std::string body;
  std::string body_omitted;
  size_t body_bytes = 0;
  std::vector<Header> headers;
  bool disconnected = false;
  bool errored = false;
  int error_code = 0;
  std::string error_what;
  std::string stop_reason;
  bool abandoned = false;
  long long total_ms = 0;
  uint64_t bytes_in = 0;
  uint64_t bytes_out = 0;

  std::atomic<long long> last_activity_ms{0};
  std::atomic<bool> stopped{false};
  std::atomic<bool> loop_returned{false};
  std::atomic<bool> report_claimed{false};

  void touch() { last_activity_ms.store(millisecondsSince(started)); }

  void stopClient() {
    if (g_client != nullptr) uvcpp_c_quic_client_stop(g_client);
  }

  /** Nothing beyond the two shared deadlines: there is no closing handshake here. */
  const char* extraStopReason(long long /*now*/) const { return nullptr; }

  void writeReport(bool was_abandoned);
};

Run* g_run = nullptr;

void requestStop(Run& run, const char* kind) {
  if (run.stopped.exchange(true)) return;
  if (g_client != nullptr) uvcpp_c_quic_client_stop(g_client);
  if (kind != nullptr && kind[0] != '\0') {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.stop_reason = kind;
  }
}

/**
 * A string an accessor wrote into a buffer, honoring the caller-provides-buffer
 * rule: the return is the real length and the write happens only when
 * `cap >= length + 1`. A return of exactly `cap` therefore means nothing was
 * written, which is why this compares rather than trusting `written > 0`.
 */
bool readText(const int written, const char* buffer, size_t capacity, std::string* out) {
  if (written <= 0) return false;
  if (static_cast<size_t>(written) + 1 > capacity) return false;
  out->assign(buffer, static_cast<size_t>(written));
  return true;
}

/** Copy one completed response into `run`. Called with `mu` already held. */
void recordResponse(Run& run, const uvcpp_c_h3_response* response) {
  // `UVCPP_C_E_NOT_FOUND` means no response head ever arrived, which is a different
  // fact from a status of 0 and has to stay one: "the peer answered nothing" and
  // "the peer said 0" are different answers.
  const int status = uvcpp_c_h3_response_status(response);
  run.status = status == UVCPP_C_E_NOT_FOUND ? 0 : status;
  run.answered = true;
  run.response_error = uvcpp_c_h3_response_error(response);

  const size_t size = uvcpp_c_h3_response_body_size(response);
  run.body_bytes = size;
  if (size == 0) {
    run.body.clear();
  } else if (size > run.options.max_body_bytes) {
    // The body cannot be read in pieces: `_response_body` writes only when the
    // buffer holds the whole thing, so a short buffer yields nothing at all and a
    // large enough one means holding whatever the peer sent. The caller said how
    // much this probe may hold, so the body is omitted and the reason carries the
    // size, rather than the allocation being made on the peer's say-so.
    run.body_omitted = "larger than max_body_bytes (" + std::to_string(size) +
                       " bytes); raise max_body_bytes to include it";
  } else {
    std::vector<char> buffer(size + 1, '\0');
    uvcpp_c_h3_response_body(response, buffer.data(), buffer.size());
    run.body.assign(buffer.data(), size);
  }

  for (const char* name : kReportedHeaders) {
    if (uvcpp_c_h3_response_has_header(response, name) != 1) continue;
    std::vector<char> value(8192, '\0');
    std::string text;
    // A header that is present but too long to read is reported as present with no
    // value rather than dropped: that it exists is itself the observation.
    readText(uvcpp_c_h3_response_header(response, name, value.data(), value.size()),
             value.data(), value.size(), &text);
    run.headers.push_back(Header{name, text});
  }
  run.touch();
}

void drainCompleted(Run& run, uvcpp_c_h3_connection* h) {
  // One at a time, which is the documented shape: a batch take would make a second
  // arrival invisible while the first is being handled.
  while (true) {
    uvcpp_c_h3_response* response = uvcpp_c_h3_response_new(0);
    if (response == nullptr) return;
    // Taken outside the lock: this reaches into the session, and the loop thread
    // never calls into the library while holding `mu` — a callback invoked from
    // inside one of those calls would otherwise find the lock held by its own
    // thread.
    const int taken = uvcpp_c_h3_conn_take_completed(h, response);
    if (taken < 1) {
      uvcpp_c_h3_response_free(response);
      return;
    }
    const std::lock_guard<std::mutex> lock(run.mu);
    // Only this probe's own request was ever sent, so the first completed response
    // is the answer to it — and both stream numbers are in the report so a caller
    // can check that rather than take it on trust.
    if (!run.answered) recordResponse(run, response);
    uvcpp_c_h3_response_free(response);
  }
}

void onStreamClose(void* /*user_data*/, uvcpp_c_h3_connection* h,
                   const uvcpp_c_h3_stream_close_info* info) {
  Run& run = *g_run;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    if (info != nullptr) {
      run.touch();
      if (run.stream_id < 0) run.stream_id = info->stream_id;
    }
  }
  // The response is guaranteed to be in the completed queue by the time this runs
  // for its stream, so there is nothing to wait for here.
  drainCompleted(run, h);
  bool answered = false;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    answered = run.answered;
  }
  // Ended here rather than at the idle deadline, which is the difference between a
  // 50ms answer and a five-second one. One request went out and its response is now
  // in hand — headers, body, and its own ending in `response_error` — so nothing
  // further on this connection could change anything in the report. A run where the
  // stream closes with no completed response keeps waiting, because then the peer
  // has not finished saying what it has to say; `idle` and `total` remain the
  // backstops for a peer that never answers at all.
  if (answered) requestStop(run, "answered");
}

void onH3Error(void* /*user_data*/, uvcpp_c_h3_connection* /*h*/, int error_code) {
  Run& run = *g_run;
  const std::lock_guard<std::mutex> lock(run.mu);
  // The library closes the QUIC connection itself when this fires, so there is
  // nothing to do here but record it. An `on_disconnect` always follows.
  run.errored = true;
  if (run.error_code == 0) run.error_code = error_code;
  run.error_what = "the HTTP/3 session ended with an error";
  run.touch();
}

void onDisconnect(void* /*user_data*/, uvcpp_c_h3_connection* h) {
  Run& run = *g_run;
  if (uvcpp_c_h3_conn_completed_count(h) > 0) drainCompleted(run, h);
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.disconnected = true;
    run.touch();
  }
  // Required here, and by this layer rather than by taste: the h3 object does not
  // own the QUIC connection, and the connection is gone.
  uvcpp_c_h3_connection_free(h);
  g_h3 = nullptr;
  requestStop(run, nullptr);
}

void onHandshake(void* /*user_data*/, int status) {
  Run& run = *g_run;
  bool failed = false;
  {
    const std::lock_guard<std::mutex> lock(run.mu);
    run.handshake_done = true;
    run.handshake_status = status;
    run.handshake_ok = status == 0;
    if (status != 0) {
      run.errored = true;
      run.error_code = status;
      run.error_what = "the QUIC handshake did not complete";
      failed = true;
    }
    run.touch();
  }
  if (failed) requestStop(run, nullptr);
}

json headersJson(const std::vector<Header>& headers) {
  json out = json::object();
  for (const Header& header : headers) out[header.name] = header.value;
  return out;
}

/** The header names this probe asked for, as a JSON array. A loop rather than
 *  `json::array(a, b)`, which is not a range constructor — nlohmann's `array()`
 *  takes an initializer list. */
json reportedHeaderNames() {
  json out = json::array();
  for (const char* name : kReportedHeaders) out.push_back(name);
  return out;
}

/** The report, from a run whose fields are settled. The caller holds `mu`. */
json reportFrom(const Run& run) {
  json out = {
      {"probe", "uvcpp-capi"},
      {"exchange", "http3"},
      {"abi_version", static_cast<int>(uvcpp_c_abi_version())},
      {"library_version",
       uvcpp_c_version_string() == nullptr ? "" : uvcpp_c_version_string()},
      {"url", run.options.url},
      {"host", run.options.host},
      {"port", run.options.port},
      {"method", run.options.method},
      {"path", run.options.path},
      {"authority", run.options.authority},
      {"verify_peer", !run.options.ca_file.empty()},
      {"handshake_completed", run.handshake_done},
      {"handshake_ok", run.handshake_ok},
      {"handshake_status", run.handshake_status},
      {"alpn", run.alpn},
      {"request_sent", run.request_sent},
      // Null rather than 0 or -1 when nothing was sent: a caller reading a stream
      // number has to be able to tell "no stream" from "stream zero".
      {"stream_id", run.request_sent ? json(run.stream_id) : json(nullptr)},
      {"send_attempts", run.send_attempts},
      {"last_send_error",
       run.last_send_error == 0 ? json(nullptr) : json(run.last_send_error)},
      {"answered", run.answered},
      // Null rather than 0 when no response head arrived; see `recordResponse`.
      {"status", run.answered && run.status != 0 ? json(run.status) : json(nullptr)},
      {"response_error", run.response_error},
      {"headers", headersJson(run.headers)},
      {"headers_observed", reportedHeaderNames()},
      {"body", run.body},
      {"body_bytes", run.body_bytes},
      {"bytes_in", run.bytes_in},
      {"bytes_out", run.bytes_out},
      {"disconnected", run.disconnected},
      {"error", run.error_what.empty()
                    ? json(nullptr)
                    : json({{"what", run.error_what}, {"code", run.error_code}})},
      {"stop_reason", run.stop_reason.empty() ? json(nullptr) : json(run.stop_reason)},
      {"total_ms", run.total_ms},
      // Said once, here, because these are properties of the stack and not of this
      // run: what the C ABI cannot see, this probe cannot report.
      {"not_observable",
       json::array({"any response header not named in headers_observed",
                    "response trailers", "the peer's HTTP/3 settings values",
                    "which ALPN the peer would have chosen from another list",
                    "timings finer than the 2ms poll interval"})},
  };
  if (!run.body_omitted.empty()) out["body_omitted"] = run.body_omitted;
  // Present when the report was written without the loop ever returning, which is
  // how a run a deadline ends ordinarily finishes here. Whatever the peer sent after
  // the last recorded fact was never read, and a caller reading a log that stops has
  // to be able to tell that from a connection that went quiet.
  if (run.abandoned) out["abandoned"] = true;
  return out;
}

void Run::writeReport(bool was_abandoned) {
  json out;
  {
    const std::lock_guard<std::mutex> lock(mu);
    abandoned = was_abandoned;
    total_ms = millisecondsSince(started);
    // Read here rather than on every poll: these only ever grow, and this is the
    // last moment the handle is known to be valid.
    if (g_h3 != nullptr) {
      bytes_in = uvcpp_c_h3_conn_bytes_in(g_h3);
      bytes_out = uvcpp_c_h3_conn_bytes_out(g_h3);
    }
    out = reportFrom(*this);
  }
  emit(out);
}

}  // namespace

int runHttp3(const json& request) {
  Run run;
  run.options.url = request.value("url", "");
  run.options.host = request.value("host", "");
  run.options.port = request.value("port", 0);
  run.options.path = request.value("path", "/");
  run.options.method = request.value("method", "GET");
  run.options.body = request.value("body", "");
  // The lossless spelling of a body. `body` above is what a caller that predates
  // this field sends; when both arrive, the bytes win. An invalid value is a
  // refusal rather than a body cut at the first bad character.
  const std::string body_base64 = request.value("body_base64", "");
  if (!body_base64.empty() && !base64Decode(body_base64, &run.options.body)) {
    return fail(kExitBadRequest, "the request's body_base64 is not valid base64");
  }
  run.options.ca_file = request.value("ca_file", "");
  run.options.authority = request.value("authority", "");
  run.options.idle_ms = request.value("idle_ms", kDefaultIdleMs);
  run.options.total_timeout_ms = request.value("total_timeout_ms", kDefaultTotalTimeoutMs);
  run.options.max_body_bytes = request.value("max_body_bytes", kDefaultMaxBodyBytes);
  for (const json& entry : request.value("headers", json::array())) {
    const std::string name = entry.value("name", "");
    if (name.empty()) return fail(kExitBadRequest, "a request header has no name");
    run.options.headers.push_back(Header{name, entry.value("value", "")});
  }
  run.idle_ms = run.options.idle_ms;
  run.total_timeout_ms = run.options.total_timeout_ms;

  // The host and the port are named separately rather than parsed out of the URL,
  // deliberately: uvp's own URI parser is the one owner of "what this URL means",
  // and a second, simpler parser here would be a second answer to that question —
  // the kind that agrees on `https://host:port/path` and disagrees on everything
  // else. The caller passes both; `url` is carried for the report only.
  if (run.options.host.empty()) return fail(kExitBadRequest, "the request has no host");
  if (run.options.port <= 0 || run.options.port > 65535) {
    return fail(kExitBadRequest, "the request's port is not in 1..65535");
  }
  if (run.options.method.empty()) return fail(kExitBadRequest, "the request has no method");
  if (run.options.path.empty()) return fail(kExitBadRequest, "the request has no path");
  if (run.options.idle_ms <= 0 || run.options.total_timeout_ms <= 0 ||
      run.options.idle_ms > run.options.total_timeout_ms) {
    return fail(kExitBadRequest,
                "idle_ms must be positive and no larger than total_timeout_ms");
  }
  if (run.options.authority.empty()) {
    run.options.authority = run.options.host + ":" + std::to_string(run.options.port);
  }
  run.started = Clock::now();

  // The crypto backend, once, before any QUIC object exists. See the note at the top
  // of this file for what happens without it.
  if (uvcpp_c_quic_crypto_init() != 0) {
    return fail(kExitCannotRun, "uvcpp_c_quic_crypto_init failed");
  }

  // A NULL `ca_file` is the documented client default — no verification — and the
  // right default here for the same reason the library chose it: a generated
  // service serves a self-signed certificate unless it was given one, so a probe
  // that verified by default would report every freshly generated service as
  // unreachable. Whether it verified is in the report either way.
  uvcpp_c_quic_tls* tls = uvcpp_c_quic_tls_client_new(nullptr);
  if (tls == nullptr) return fail(kExitCannotRun, "uvcpp_c_quic_tls_client_new failed");
  if (!run.options.ca_file.empty()) {
    if (uvcpp_c_quic_tls_set_ca_file(tls, run.options.ca_file.c_str()) != UVCPP_C_OK) {
      uvcpp_c_quic_tls_free(tls);
      return fail(kExitBadRequest, "the CA file " + run.options.ca_file +
                                       " could not be read as a PEM bundle");
    }
    // Installing a trust store is not the same as verifying against it, and the
    // header says so; both steps are needed.
    if (uvcpp_c_quic_tls_set_verify(tls, 1) != UVCPP_C_OK) {
      uvcpp_c_quic_tls_free(tls);
      return fail(kExitCannotRun, "uvcpp_c_quic_tls_set_verify failed");
    }
  }

  uvcpp_c_quic_client* client = uvcpp_c_quic_client_new();
  if (client == nullptr) {
    uvcpp_c_quic_tls_free(tls);
    return fail(kExitCannotRun, "uvcpp_c_quic_client_new failed");
  }
  if (uvcpp_c_quic_client_set_tls(client, tls) != UVCPP_C_OK) {
    uvcpp_c_quic_client_free(client);
    uvcpp_c_quic_tls_free(tls);
    return fail(kExitCannotRun, "uvcpp_c_quic_client_set_tls failed");
  }
  // The library's own idle timeout defaults to 30s. Raised past this run's total
  // deadline so a quiet peer is reported as this probe's `idle`, with whatever it
  // did or did not send intact, rather than as a transport timeout. Set before
  // `_connect`, which is the only moment it counts.
  (void)uvcpp_c_quic_client_set_idle_timeout(
      client, static_cast<uint64_t>(run.total_timeout_ms) + 10'000);

  g_client = client;
  g_run = &run;

  const int connected = uvcpp_c_quic_client_connect(client, run.options.host.c_str(),
                                                    run.options.port, onHandshake, nullptr);
  if (connected != UVCPP_C_OK) {
    // Reported rather than refused. A synchronous rejection is what an unresolvable
    // host looks like, and "the host does not resolve" is a fact about the target,
    // not a bad request — so it travels in the same shape as every other run that
    // never handshook, with the code and the library's own name for it. Refusing
    // here would make the one exit code that means "uvp asked wrong" also mean "the
    // name did not resolve", and no caller can act on an exit code that says both.
    const char* name = uvcpp_c_strerror(connected);
    {
      const std::lock_guard<std::mutex> lock(run.mu);
      run.handshake_status = connected;
      run.error_what = name == nullptr ? std::to_string(connected) : name;
      run.error_code = connected;
    }
    uvcpp_c_quic_client_free(client);
    uvcpp_c_quic_tls_free(tls);
    g_client = nullptr;
    g_run = nullptr;
    run.writeReport(false);
    return kExitOk;
  }

  // The one moment the h3 connection may be built on a client: after `_connect()`
  // has returned and before the loop is pumped again.
  uvcpp_c_quic_connection* connection = uvcpp_c_quic_client_connection(client);
  if (connection == nullptr) {
    uvcpp_c_quic_client_free(client);
    uvcpp_c_quic_tls_free(tls);
    g_client = nullptr;
    g_run = nullptr;
    return fail(kExitCannotRun, "uvcpp_c_quic_client_connection returned nothing");
  }
  g_h3 = uvcpp_c_h3_connection_new(connection, /*server_side=*/0);
  if (g_h3 == nullptr) {
    uvcpp_c_quic_client_free(client);
    uvcpp_c_quic_tls_free(tls);
    g_client = nullptr;
    g_run = nullptr;
    return fail(kExitCannotRun, "uvcpp_c_h3_connection_new failed");
  }

  uvcpp_c_h3_callbacks callbacks{};
  callbacks.size = static_cast<uint32_t>(sizeof(callbacks));
  callbacks.on_stream_close = onStreamClose;
  callbacks.on_error = onH3Error;
  callbacks.on_disconnect = onDisconnect;
  if (uvcpp_c_h3_conn_start(g_h3, &callbacks, nullptr) != 0) {
    uvcpp_c_h3_connection_free(g_h3);
    g_h3 = nullptr;
    uvcpp_c_quic_client_free(client);
    uvcpp_c_quic_tls_free(tls);
    g_client = nullptr;
    g_run = nullptr;
    return fail(kExitCannotRun, "uvcpp_c_h3_conn_start failed");
  }

  std::thread watchdog(watch<Run>, std::ref(run));

  while (!run.stopped.load()) {
    if (g_h3 != nullptr && uvcpp_c_h3_conn_ready(g_h3) == 1) {
      // The critical streams exist only after ALPN, so `_conn_ready()` is 0 for the
      // first rounds and that is normal rather than a failure. It is also the first
      // moment the ALPN can be read, and it does not change afterwards.
      if (run.alpn.empty()) {
        std::vector<char> buffer(256, '\0');
        std::string alpn;
        if (readText(uvcpp_c_h3_conn_alpn_selected(g_h3, buffer.data(), buffer.size()),
                     buffer.data(), buffer.size(), &alpn) &&
            !alpn.empty()) {
          const std::lock_guard<std::mutex> lock(run.mu);
          if (run.alpn.empty()) run.alpn = alpn;
        }
      }
      if (!run.request_sent) {
        uvcpp_c_h3_request* req =
            uvcpp_c_h3_request_new(run.options.method.c_str(), run.options.path.c_str());
        if (req == nullptr) break;
        uvcpp_c_h3_request_set_authority(req, run.options.authority.c_str());
        for (const Header& header : run.options.headers) {
          uvcpp_c_h3_request_set_header(req, header.name.c_str(), header.value.c_str());
        }
        if (!run.options.body.empty()) {
          uvcpp_c_h3_request_set_body(req, run.options.body.data(), run.options.body.size());
        }
        const int64_t stream_id = uvcpp_c_h3_conn_send_request(g_h3, req);
        uvcpp_c_h3_request_free(req);
        {
          const std::lock_guard<std::mutex> lock(run.mu);
          run.send_attempts += 1;
          run.touch();
          if (stream_id >= 0) {
            run.request_sent = true;
            run.stream_id = stream_id;
          } else {
            // Two of the negative codes are documented as ordinary results — the
            // critical streams may not be open yet, or the peer may not have granted
            // a stream — and they are indistinguishable here without including
            // ngtcp2's private headers. So the code is recorded as the number it is,
            // retried while the connection lives and the deadline has not passed, and
            // never interpreted into a verdict this layer is not entitled to reach.
            run.last_send_error = static_cast<int>(stream_id);
          }
        }
        if (uvcpp_c_h3_conn_closed(g_h3) == 1) break;
      }
    }
    uvcpp_c_quic_client_run_once(client);
    std::this_thread::sleep_for(std::chrono::milliseconds(kPollIntervalMs));
  }

  run.loop_returned.store(true);
  watchdog.join();

  if (!run.report_claimed.exchange(true)) run.writeReport(false);

  // The h3 object first: the client owns the QUIC connection, so freeing the client
  // underneath a live h3 object would leave it pointing at a poisoned handle. The
  // same order `onDisconnect` uses, for the same reason.
  if (g_h3 != nullptr) {
    uvcpp_c_h3_connection_free(g_h3);
    g_h3 = nullptr;
  }
  uvcpp_c_quic_client_free(client);
  uvcpp_c_quic_tls_free(tls);
  g_client = nullptr;
  g_run = nullptr;
  return kExitOk;
}

}  // namespace probe
