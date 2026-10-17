---
layout: home

hero:
  name: uvp
  text: libuv-powered, AI-native web framework
  tagline: Describe a C++ web service. Get code that builds, runs, and answers — with the evidence to prove it.
  actions:
    - theme: brand
      text: Get started
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/Antruly/uvp

features:
  - title: Generate real C++ projects
    details: Five templates that produce ordinary CMake projects linking libuvcpp. No uvp runtime, nothing to install alongside. Walk away and keep the code.
    link: /installation
  - title: Prove it works
    details: Build, launch, drive requests, and evaluate assertions in one supervised pass — then read a report that separates observed, derived, and unknown.
    link: /evidence
  - title: One contract, two surfaces
    details: The same tool contracts back the CLI and the MCP server, so an agent and a shell script get identical behaviour and identical evidence.
    link: /mcp-contracts
---

## Build a service from a sentence

An agent connected over MCP can take a description and return a running,
verified service:

> Build a JSON API on port 8080 with an `/items` collection and a WebSocket echo
> endpoint, then prove `/items/1` returns 200 with the right body.

The agent scaffolds the workspace, builds it against your libuvcpp install, starts
it, drives the requests, and reports back. If the build fails, the compiler
diagnostics come back as structured, phase-tagged data and the agent can fix
them.

## Or from the terminal

```bash
uvp doctor --json
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket
uvp verify ./svc --port 8080 \
  --request GET /items/1 \
  --assert status=200 \
  --assert 'json:$.value=first'
```

`uvp doctor` is the first command to run. It reports the compiler, CMake, and
libuvcpp build it found, which modules that build provides, and which
capabilities each gap actually blocks.

## Choose a guide

| Task                                          | Guides                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Install and connect an agent                  | [Installation and setup](installation.md)                        |
| Learn the command surface and its output      | [CLI and evidence](cli.md)                                       |
| Understand how uvp is put together            | [Architecture](architecture.md)                                  |
| Read a verification report correctly          | [Evidence model](evidence.md)                                    |
| Check what a libuvcpp build actually provides | [libuvcpp feature mapping](libuvcpp-features.md)                 |
| Add a tool or change a contract               | [Tool design](tool-design.md), [MCP contracts](mcp-contracts.md) |
| Work on uvp itself                            | [Testing](testing.md), [Releasing](releasing.md)                 |
| Work with AI agents                           | [AI development workflow](agent-workflow.md)                     |

## What uvp is not

It is not a C++ framework you link. There is no `uvp::core` target and no runtime
library. uvp is a generator, a build driver, and a verifier; the code it produces
belongs to you and depends only on libuvcpp.

It is also not a benchmark of your service, a production deployment tool, or a
sandbox. Generated services run with your permissions on your machine. See the
[disclaimer](https://github.com/Antruly/uvp/blob/main/DISCLAIMER.md).
