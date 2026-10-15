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

add_executable(uvcpp-probe main.cpp)
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
