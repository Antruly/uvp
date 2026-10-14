# Disclaimer

## Responsible use

uvp is built for lawful software development: building and testing web services
you own or are authorised to work on, performance measurement during development,
API and SOAP integration work, and learning how libuvcpp's HTTP, HTTP/2,
WebSocket, and TLS layers behave.

The uvp project does not support, and will not help with:

- sending traffic to systems you do not own or have permission to test,
  including load generation against a third party's service;
- scanning, probing, or enumerating hosts you are not authorised to examine;
- building services whose purpose is to attack, deceive, or degrade another
  system;
- intercepting traffic on a network you are not authorised to monitor;
- defeating authentication, access controls, or transport security on systems
  you do not control.

`uvp_load_test` exists to measure a service **you are developing**, on a host you
control. Running it against a service you do not own may be unlawful and may
degrade a system other people depend on.

You are responsible for obtaining any required authorisation and for complying
with applicable laws and the terms of service of any network you connect to.
Capturing traffic can be regulated independently of who owns the endpoints.

## User responsibility

uvp generates code and runs it. The generated service runs with your permissions,
listens on the port you chose, and can be reached by anything that can reach that
port. You decide where it listens, what it does, and how long it runs.

Generated code is a starting point, not a reviewed product. uvp's templates are
deliberately small and are verified to compile and answer requests; they are not
audited for production use. Read what you ship.

## Runtime, network, and device operations

uvp starts processes, opens listening sockets, opens client connections, and
writes files. Each of these is declared in the `effects` block of the corresponding
tool contract, and an MCP client shows those declarations before running a tool.
The declarations describe what a tool can do; they are not a sandbox and do not
prevent a tool from doing it.

uvp does not run as a privileged user and never invokes `sudo`. It does not
install, upgrade, or modify libuvcpp, your compiler, or CMake.

## Analysis results and generated output

A build that succeeds establishes that the code compiled and linked on this host,
with this toolchain, against this libuvcpp build. It does not establish that the
service is correct, secure, or portable.

A verification pass with status `verified` establishes that every step uvp
attempted succeeded. It does not establish that steps uvp did **not** attempt
would have succeeded. Read the residual unknowns in the report; they are the
honest boundary of what was proven, and they are reported rather than omitted.

Performance figures from `uvp_load_test` describe one host, one build
configuration, and one workload. They are not a benchmark of libuvcpp or of your
service in general.

## Third-party tools and licenses

uvp builds against [libuvcpp](https://github.com/Antruly/libuvcpp), which is
distributed under its own license and is not bundled with uvp. Your compiler,
your CMake, and libuvcpp retain their own licenses and their own terms. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer of warranty

uvp is provided **AS IS**, without express or implied warranties, including
merchantability, fitness for a particular purpose, and noninfringement, as set
out in the [MIT License](LICENSE). You assume the risks of using the software and
of deciding whether it is suitable for your task. No project description,
example, generated template, or verification result guarantees a particular
outcome or establishes that your intended use is lawful or safe.

## Limitation of liability

In no event shall the authors or copyright holders be liable for any claim,
damages, or other liability, whether in an action of contract, tort, or
otherwise, arising from, out of, or in connection with the software or the use
or other dealings in the software.

## Disclaimer of endorsement

References to third-party projects, products, and trademarks identify their work
and uvp's integrations. Credits and thanks do not imply affiliation, sponsorship,
approval, or endorsement by the named parties. Redistribution, bundling, or
hosting by a third party does not by itself imply affiliation with or endorsement
by the uvp project.

## Relationship to software licenses

This document explains uvp's intended use, user responsibilities, and community
support boundaries. It does not amend the MIT license, impose additional
copyright-license conditions, replace upstream licenses, or grant rights to
third-party software. The applicable software licenses retain their own terms.

## Versions, distribution channels, and platforms

The project's position on lawful use and non-endorsement covers all uvp versions,
distribution forms, and platforms, including Git commits, source checkouts,
release archives, published packages, and redistributed copies, regardless of
installation method, agent client, or operating system. Using an older version or
another distribution channel does not imply project endorsement or remove
obligations under applicable law or to respect third-party rights.

Each copy remains subject to the licenses accompanying that copy. This statement
does not retroactively amend existing license grants, add license conditions, or
expand historical warranty or liability exclusions.
