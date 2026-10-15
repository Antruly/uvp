# The native WebSocket probe.
#
# A plain CMake project, like the projects uvp generates, and deliberately not a
# Node addon: the probe is a process because a hang in a native addon is a hang in
# the MCP server that loaded it, while a hang in a child process is a timeout.
#
# It is built by `npm run build:native-probe`, which resolves the libuvcpp install
# with uvp's own toolchain discovery and passes it in as UVCPP_INCLUDE_DIR and
# UVCPP_LIBRARY. That is why there is no find_package/pkg-config ladder here: the
# search order for a libuvcpp install has one owner, and it is not this file.
#
# The C API is the point. `UVCPP_ENABLE_CAPI=ON` is what puts `capi/uvcpp_c.h` and
# the `uvcpp_c_*` symbols into an install, so a configure against an install built
# without it fails here, loudly, on the missing header.

cmake_minimum_required(VERSION 3.20)
project(uvcpp-probe CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT UVCPP_INCLUDE_DIR)
  message(FATAL_ERROR "UVCPP_INCLUDE_DIR is required: pass the include directory of a libuvcpp install built with UVCPP_ENABLE_CAPI=ON.")
endif()
if(NOT UVCPP_LIBRARY)
  message(FATAL_ERROR "UVCPP_LIBRARY is required: pass the full path to the libuvcpp library to link.")
endif()

find_path(UVCPP_CAPI_HEADER
  NAMES capi/uvcpp_c.h
  PATHS "${UVCPP_INCLUDE_DIR}"
  NO_DEFAULT_PATH
)
if(NOT UVCPP_CAPI_HEADER)
  message(FATAL_ERROR
    "capi/uvcpp_c.h is not in ${UVCPP_INCLUDE_DIR}. This libuvcpp install was built "
    "without its C ABI; rebuild it with -DUVCPP_ENABLE_CAPI=ON to use the native probe.")
endif()

# The probe writes and reads JSON, and libuvcpp's install ships nlohmann/json
# beside its own headers. Taking it from there rather than vendoring a copy keeps
# this repository free of a third-party tree it would have to notice and update.
find_path(NLOHMANN_JSON_HEADER
  NAMES nlohmann/json.hpp
  PATHS "${UVCPP_INCLUDE_DIR}"
  NO_DEFAULT_PATH
)
if(NOT NLOHMANN_JSON_HEADER)
  message(FATAL_ERROR "nlohmann/json.hpp is not in ${UVCPP_INCLUDE_DIR}; the probe needs it to read its request.")
endif()

# The HTTP/3 exchange is compiled only when this install has the HTTP/3 C ABI.
#
# Without the gate the probe does not build *at all* against an install built
# without HTTP3, which cost the WebSocket half its native stack for a reason that
# has nothing to do with WebSocket, and turned a property of one install into a
# property of the tool.
#
# The question is put to the compiler rather than to a file this script reads,
# because the compiler is what has to be satisfied. `capi/uvcpp_c.h` pulls in the
# h3 declarations under libuvcpp's own `UVCPP_HTTP3_ENABLE`, so a program that
# includes it and names an h3 symbol compiles exactly when the install has that
# ABI — whatever the install's layout, and whatever a packager moved. Reading
# `uvcpp_config.h` here instead would be a second reader of a header uvp already
# has one of, and it can disagree with the compile in either direction: this check
# was first written as "is capi/uvcpp_c_http3.h on disk", and against an install
# whose config header still enables HTTP/3 while that header was never installed it
# answered "no HTTP/3" — a probe that should have been built WebSocket-only — while
# in truth not one translation unit here could be compiled.
#
# Compiled, not linked: `CMAKE_REQUIRED_LIBRARIES` would drag in the install's own
# dependencies, which a source install does not resolve without the loader path its
# lane sets. A declaration is the compile-time half of the question, and the link
# step below answers the rest by failing loudly if the symbol is not there.
include(CheckCXXSourceCompiles)
set(CMAKE_REQUIRED_INCLUDES "${UVCPP_INCLUDE_DIR}")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
check_cxx_source_compiles("
#include <capi/uvcpp_c.h>
#include <cstddef>
int main() {
  char version[64];
  return uvcpp_c_h3_version(version, sizeof(version));
}
" UVCPP_HAS_HTTP3_C_API)

# When the answer is no, there are two different situations behind it and only one
# of them is a probe that can still be built.
#
# The ordinary one is an install configured without HTTP/3: its config header says
# so, the umbrella header leaves the h3 declarations out, and every translation
# unit here compiles — the two that do not need h3 and, above all, `main.cpp`,
# which includes the umbrella whatever exchange is being built. The other is an
# install that contradicts itself: a config header that still enables HTTP/3 whose
# h3 header was not installed, taken away, or moved by a packager. There the
# umbrella fails to compile, so *no* exchange can be built, and the failure arrives
# as a compiler error inside `main.cpp` about a header nothing there asked for.
# Asking the second question turns that cascade into one sentence naming the
# contradiction — and says it before a single object file is produced.
if(NOT UVCPP_HAS_HTTP3_C_API)
  check_cxx_source_compiles("
#include <capi/uvcpp_c.h>
int main() { return 0; }
" UVCPP_CAPI_UMBRELLA_COMPILES)
  if(NOT UVCPP_CAPI_UMBRELLA_COMPILES)
    message(FATAL_ERROR
      "capi/uvcpp_c.h at ${UVCPP_INCLUDE_DIR} does not compile on its own. It is not a "
      "missing HTTP/3 module: this install contradicts itself, most often a config header "
      "generated with -DUVCPP_ENABLE_HTTP3=ON whose capi/uvcpp_c_http3.h was not installed "
      "beside it. Every translation unit of this probe includes that header, so no exchange "
      "can be built against this install, and the fix is the install rather than this build: "
      "reinstall libuvcpp so its headers match its generated config header.")
  endif()
endif()

# Three translation units when the install has HTTP/3 — one per exchange, plus
# `main.cpp` holding the protocol both of them speak — and two when it does not.
# One file per exchange is what keeps the h3 half from becoming a second copy of the
# WebSocket half's ending logic: the shared part lives in `probe.h`, and the
# watchdog in it is a template over each exchange's own run state.
add_executable(uvcpp-probe main.cpp websocket_exchange.cpp)
if(UVCPP_HAS_HTTP3_C_API)
  target_sources(uvcpp-probe PRIVATE http3_exchange.cpp)
  target_compile_definitions(uvcpp-probe PRIVATE UVCPP_PROBE_HTTP3_EXCHANGE=1)
  message(STATUS "libuvcpp at ${UVCPP_INCLUDE_DIR} has the HTTP/3 C ABI; building the http3 exchange")
else()
  # Said out loud rather than left to be found in `--version` on a binary that was
  # already shipped somewhere: this is the case where the probe is complete for one
  # exchange and cannot ever answer the other.
  message(STATUS
    "libuvcpp at ${UVCPP_INCLUDE_DIR} has no HTTP/3 C ABI, so the http3 exchange is not "
    "built into this probe; the WebSocket exchange is unaffected")
endif()
target_include_directories(uvcpp-probe PRIVATE "${UVCPP_INCLUDE_DIR}")
target_link_libraries(uvcpp-probe PRIVATE "${UVCPP_LIBRARY}")

find_package(Threads REQUIRED)
target_link_libraries(uvcpp-probe PRIVATE Threads::Threads)

# Linked by absolute path, so the runtime needs to be told where the library is:
# the install is wherever the caller unpacked it, and an rpath is the difference
# between a probe that runs and one that only runs under `ldd`-style guessing.
get_filename_component(UVCPP_LIBRARY_DIR "${UVCPP_LIBRARY}" DIRECTORY)
if(APPLE)
  set_target_properties(uvcpp-probe PROPERTIES INSTALL_RPATH "${UVCPP_LIBRARY_DIR}")
  target_link_options(uvcpp-probe PRIVATE "-Wl,-rpath,${UVCPP_LIBRARY_DIR}")
elseif(UNIX)
  target_link_options(uvcpp-probe PRIVATE "-Wl,-rpath,${UVCPP_LIBRARY_DIR}")
endif()

if(MSVC)
  target_compile_options(uvcpp-probe PRIVATE /W4 /utf-8)
else()
  target_compile_options(uvcpp-probe PRIVATE -Wall -Wextra -Wpedantic)
endif()
