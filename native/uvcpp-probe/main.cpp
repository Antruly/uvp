/**
 * uvcpp-probe: libuvcpp's own clients, asked to talk to a service uvp generated.
 *
 * uvp's own probes speak WebSocket and HTTP from Node. That is a real check of
 * the service on the other end, but it is a check made by a *different*
 * implementation than the one a generated service links: two clients that agree
 * on RFC 6455 (or on HTTP/3) can disagree on everything the spec leaves open, and
 * a uvp-generated service answering a Node client says nothing about whether
 * libuvcpp's own client stack can talk to it. This program exists so that question
 * can be asked: it links libuvcpp and drives the exchange through the C ABI, which
 * is libuvcpp's own client reaching the wire.
 *
 * It answers two questions, one per run:
 *
 *   - `"exchange": "websocket"` (the default) — one `uvcpp_c_ws_client` session,
 *     reported as the frames it observed. See `websocket_exchange.cpp`.
 *   - `"exchange": "http3"` — one HTTP/3 request over QUIC, reported as the
 *     response. See `http3_exchange.cpp`.
 *
 * One process, one request, one report. A caller that wants both runs it twice.
 *
 * The HTTP/3 half is built only against an install that has the HTTP/3 C ABI, so
 * which exchanges a given binary has is a property of *the build* and not of this
 * source. `--version` reports both answers: `exchanges`, the list it can run, and
 * `unavailable_exchanges`, the reason for a name it cannot — because the remedy
 * for a missing exchange is sometimes a different libuvcpp rather than a rebuild,
 * and a caller cannot tell those apart from a list with a gap in it.
 *
 * Four shape decisions, all of them about being able to trust what comes back:
 *
 *   - **It is a process, not an addon.** A native addon would run inside the MCP
 *     server, where a hang in C++ is a hang in the tool, and a crash takes the
 *     session with it. Here a hang is a child process that a timeout kills, and a
 *     crash is an exit code.
 *   - **It ends itself rather than asking the loop to stop.** `stop()` is the only
 *     call the C ABI allows from a thread that is not the loop's, and on this stack
 *     it sets a flag and does not wake anything: `uv_stop` cannot interrupt a loop
 *     already blocked in `poll`, and these clients' loops have nothing else to wake
 *     them — no timer, no async handle, no `post`. So a peer that goes quiet leaves
 *     the loop parked indefinitely, and a probe promises a bounded runtime: a
 *     deadline that passes ends the process, with the report written from the
 *     watchdog. `abandoned` in the report says so, and says that whatever arrived
 *     after the last recorded fact was never read.
 *   - **It reports only what it saw.** Neither exchange reports a field the C ABI
 *     cannot supply, and both say in `not_observable` what that stack cannot look
 *     at. A field that is absent is absent, not guessed at.
 *   - **It decides nothing about what an observation means.** This program reports
 *     frames and responses; whether any of them answers a caller's question is not
 *     asked here. The caller's own probes answer that, once, for both stacks — and
 *     a second matcher in this program would be a second rule about what counts,
 *     sitting where nobody looking at the caller would find it.
 *
 * Protocol: one JSON object on stdin, one JSON object on stdout, nothing else on
 * stdout ever. Diagnostics go to stderr. Exit code 0 means "a report was produced"
 * — including a report that says the connection was refused, which is an
 * observation and not a failure. Exit code 2 means the request could not be read,
 * and exit code 3 means this program could not run (a header/library ABI mismatch).
 * Both of those print a JSON object too, with `error` set, so a caller that parses
 * stdout never has to fall back to reading an exit code it did not expect.
 */

#include "probe.h"

#include <capi/uvcpp_c.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

/** Run one WebSocket exchange. Defined in `websocket_exchange.cpp`. */
namespace probe {
int runWebSocket(const json& request);
#ifdef UVCPP_PROBE_HTTP3_EXCHANGE
/** Run one HTTP/3 exchange. Defined in `http3_exchange.cpp`. */
int runHttp3(const json& request);
#endif
}  // namespace probe

namespace probe {

long long millisecondsSince(const Clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}

/**
 * Is this a valid UTF-8 sequence?
 *
 * Checked rather than assumed because the answer decides whether a payload can be
 * reported as `text` at all: JSON cannot carry a byte that is not valid UTF-8, and
 * a received payload holding invalid bytes is a protocol violation the caller
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
 * Base64, so a binary payload reads the same way it does from uvp's own probes.
 *
 * uvp's Node-side probe reports a binary payload as `base64`, and a second stack
 * that reported only a byte count would make the same bytes look like less
 * information than they are.
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

/**
 * The inverse of `base64Encode`: the exact bytes, or false when the text is not
 * padded base64.
 *
 * The request body crosses the protocol as JSON, which cannot carry a byte that
 * is not valid UTF-8; decoding here is what makes a binary request body reach
 * the peer as the bytes the caller supplied. Validation is part of the contract
 * rather than politeness: a body silently truncated at the first bad character
 * would be sent as a different request under the same tool call.
 */
bool base64Decode(const std::string& text, std::string* bytes) {
  const auto digit = [](char value) -> int {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    if (value == '+') return 62;
    if (value == '/') return 63;
    return -1;
  };

  if (text.size() % 4 != 0) return false;

  std::string decoded;
  decoded.reserve((text.size() / 4) * 3);
  int buffer = 0;
  int bits = 0;
  int padding = 0;
  bool seen_padding = false;
  for (const char value : text) {
    if (value == '=') {
      seen_padding = true;
      ++padding;
      continue;
    }
    // Padding is a suffix. A digit after it means this is not base64, not a body
    // with a stray character.
    if (seen_padding) return false;
    const int sextet = digit(value);
    if (sextet < 0) return false;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded.push_back(static_cast<char>((buffer >> bits) & 0xFF));
    }
  }
  if (padding > 2) return false;
  // How many bits are left over must agree with how the string was padded:
  // no padding leaves none, "=" leaves two, "==" leaves four.
  if ((padding == 0 && bits != 0) || (padding == 1 && bits != 2) ||
      (padding == 2 && bits != 4)) {
    return false;
  }
  *bytes = std::move(decoded);
  return true;
}

void emit(const json& value) {
  std::cout << value.dump() << "\n";
  std::cout.flush();
}

int fail(int code, const std::string& message) {
  emit(json({{"probe", "uvcpp-capi"},
             {"exchange", nullptr},
             {"error", {{"what", message}}}}));
  std::cerr << "uvcpp-probe: " << message << "\n";
  return code;
}

/** The exchanges this build can run, in the order the header comment lists them.
 *
 *  `http3` is here only when the translation unit that implements it was compiled,
 *  which the build decides from the install it was pointed at. A build that could
 *  not compile it must not list it: an exchange named here and dispatched to
 *  nothing is the same defect as a report about a transport nobody used. */
#ifdef UVCPP_PROBE_HTTP3_EXCHANGE
constexpr const char* kExchanges[] = {"websocket", "http3"};
#else
constexpr const char* kExchanges[] = {"websocket"};
#endif

/** A list of names as a JSON array. A loop rather than `json::array(a, b)`, which
 *  is not a range constructor — nlohmann's `array()` takes an initializer list. */
json namesJson(const char* const* names, size_t count) {
  json out = json::array();
  for (size_t index = 0; index < count; ++index) out.push_back(names[index]);
  return out;
}

/**
 * Why this build has no exchange of that name, for the ones it knows it lacks.
 *
 * The exchange list already says *that* an exchange is missing, and a caller that
 * saw only the list would do the reasonable thing and rebuild the probe — which
 * cannot work here, because what is missing is in the libuvcpp install rather than
 * in this program. So the reason travels with the list: a caller needs to be told
 * to change the install, not to repeat a build that will produce the same binary.
 *
 * It says what this binary knows and no more. What it knows is that it was not
 * compiled with the http3 translation unit, because the build's own compile check
 * against the install did not find the HTTP/3 C ABI — an install configured with
 * `-DUVCPP_ENABLE_HTTP3=OFF`, or one that does not ship those headers. It does not
 * know why that check failed: it cannot see the include directory of the install it
 * was built against, and by the time it runs, the library beside it may not even be
 * the one it was compiled against. So the sentence names the build-time fact and
 * the likely cause, and lets the caller check the install rather than asserting
 * what is on its disk.
 *
 * Empty for `websocket` (always built) and for a probe built against an install
 * that has HTTP/3 (which has nothing to explain).
 */
std::string unavailableReason(const std::string& exchange) {
#ifndef UVCPP_PROBE_HTTP3_EXCHANGE
  if (exchange == "http3") {
    return "this probe was built without the http3 exchange: the libuvcpp install it was "
           "compiled against did not expose the HTTP/3 C ABI, which is what an install "
           "configured with -DUVCPP_ENABLE_HTTP3=OFF (or one whose HTTP/3 headers were not "
           "installed) looks like; build libuvcpp with -DUVCPP_ENABLE_HTTP3=ON and "
           "-DUVCPP_ENABLE_QUIC=ON, then rebuild this probe against that install";
  }
#endif
  (void)exchange;
  return "";
}

/**
 * The reasons above as the JSON object `--version` reports, keyed by exchange.
 *
 * Written even when it is empty, so that a caller can tell "this build has
 * nothing unavailable" from a build that is too old to answer the question —
 * `exchanges` alone could not, because a missing name and an unexplained name
 * look the same in a list.
 */
json unavailableExchangesJson() {
  json out = json::object();
  const std::string reason = unavailableReason("http3");
  if (!reason.empty()) out["http3"] = reason;
  return out;
}

}  // namespace probe

int main(int argc, char** argv) {
  using namespace probe;
  std::ios::sync_with_stdio(false);

  if (argc > 1 && std::strcmp(argv[1], "--version") == 0) {
    // The availability probe: it proves this binary runs, and it reports the ABI it
    // was built against so a caller can tell a mismatch from a missing file.
    emit(json({{"probe", "uvcpp-capi"},
               {"abi_version", static_cast<int>(uvcpp_c_abi_version())},
               {"header_abi_version", static_cast<int>(UVCPP_C_ABI_VERSION)},
               {"library_version",
                uvcpp_c_version_string() == nullptr ? "" : uvcpp_c_version_string()},
               {"exchanges", namesJson(kExchanges, sizeof(kExchanges) / sizeof(kExchanges[0]))},
               {"unavailable_exchanges", unavailableExchangesJson()}}));
    return uvcpp_c_abi_version() == UVCPP_C_ABI_VERSION ? kExitOk : kExitCannotRun;
  }

  // Header and library version first: everything below assumes the two agree, and a
  // mismatch here is the failure mode with no useful symptom.
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
    return fail(kExitBadRequest,
                std::string("the request is not one JSON object: ") + error.what());
  }
  if (!request.is_object()) return fail(kExitBadRequest, "the request is not a JSON object");

  const std::string exchange = request.value("exchange", "websocket");
  if (exchange == "websocket") return runWebSocket(request);
#ifdef UVCPP_PROBE_HTTP3_EXCHANGE
  if (exchange == "http3") return runHttp3(request);
#endif
  // Refused rather than answered with a run of a different exchange: a caller that
  // asked for a transport this build cannot drive must not be handed a report about
  // another one, since nothing in that report would say so.
  //
  // The refusal repeats what `--version` says about a known-missing exchange, so a
  // caller that skipped the availability check gets the same sentence rather than a
  // second, vaguer one. It is the same sentence, from the same function — a copy
  // here would be a second description of one fact.
  const std::string reason = unavailableReason(exchange);
  if (!reason.empty()) return fail(kExitBadRequest, reason);
  return fail(kExitBadRequest, "this probe does not have an exchange named " + exchange);
}
