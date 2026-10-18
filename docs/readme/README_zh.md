<div align="center">

[English](../../README.md) · **简体中文**

# uvp：libuv 驱动、AI 原生的 Web 框架

### 一个 MCP，用来构建、运行并验证由 libuvcpp 驱动的 C++ Web 服务。

**描述一个服务，得到能编译、能运行、能应答的 C++ —— 以及证明它确实如此的证据。**

[![MCP 工具目录](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../mcp-contracts.md#generated-catalog)
[![libuvcpp 基线](https://img.shields.io/badge/libuvcpp-1.7.0-2c3e50?style=flat-square)](https://github.com/Antruly/libuvcpp)
[![Node.js 版本要求](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#环境要求)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)

[快速开始](#快速开始) · [uvp 如何工作](#uvp-如何工作) · [uvp 能做什么](#uvp-能做什么) · [当前状态](#当前状态) · [常见问题](#常见问题) · [文档](#文档)

<code>npx uvp-agents setup</code>

</div>

> [!IMPORTANT]
> uvp 通过 [Antruly/uvp](https://github.com/Antruly/uvp) 分发，并已发布到 npm
> 的 `uvp-agents` 包。仅凭仓库名相似或 README 雷同，并不能证明某个下载来源是官方渠道。

---

uvp 把一段关于 C++ Web 服务的描述变成真实的 CMake 工程：针对
[libuvcpp](https://github.com/Antruly/libuvcpp) 编译它、启动它、向它发起请求，
最后交回一份报告 —— 报告里清楚区分它**直接观测到**的事实、它**推导**出的结论，
以及它**无法确认**的部分。

它是一个 CLI 加一个 MCP server。同一套十五个工具契约同时支撑两者，
因此 Agent 和 shell 脚本得到的行为一致、证据也一致。

生成的代码不是 uvp 的附属产物。它就是普通的 libuvcpp C++，
用 `cmake -S . -B build && cmake --build build` 即可编译，无需再装别的东西。
你随时可以离开 uvp，把这个工程带走。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`
- C++14 工具链（`g++` 或 `clang++`）以及 CMake 3.20+
- [libuvcpp](https://github.com/Antruly/libuvcpp) **1.7.0 或更新版本**，
  通过 `cmake --install` 安装，或从发布压缩包解压

先跑 doctor。它会报告哪些组件已就绪、哪些缺失，以及每个缺口究竟挡住了哪些能力
—— 而不是把一切笼统地当作一个整体失败：

```bash
uvp doctor --json
```

### 配置你的 Agent

```bash
npx uvp-agents setup
```

如果希望从源码检出运行：

```bash
git clone https://github.com/Antruly/uvp
cd uvp
npm ci && npm run build:cached
node scripts/uvp.mjs setup
```

setup 会先打印它打算做出的每一处配置改动，得到确认后才写入，
并且会备份已有配置。

### 让 Agent 开始工作

> 帮我建一个跑在 8080 端口上的 JSON API，带一个 `/items` 集合和一个 WebSocket
> 回显端点。然后把它启动起来，证明 `/items/1` 返回 200 且响应体正确，
> 再证明回显端点真的能回显。

Agent 会生成工作区、编译、运行、发起请求，最后交回一个验证包。
如果编译失败，编译器诊断会以结构化数据返回，Agent 可以直接据此修复。

### 用终端

```bash
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket
uvp build ./svc
uvp run ./svc --port 8080
uvp http GET http://127.0.0.1:8080/items/1 --json
```

`uvp run` 默认分离运行：命令返回后服务仍在监听，而之后执行的
`uvp stop --all` 是一个新的 CLI 进程，注册表为空，看不到之前启动的服务。
停止 `uvp run` 打印的 pid，加上 `--no-detach` 让命令留在前台，或者使用下面的
托管流程 —— 它在一次调用中启动、检查并停止服务。

或者执行一次全程托管、结束后自行清理的流程（写成一行，`cmd.exe` 与 POSIX
shell 都能直接粘贴；双引号在所有 shell 中都保留 JSONPath）：

```bash
uvp verify ./svc --port 8080 --request GET /items/1 --assert status=200 --assert "json:$.value=first"
```

## uvp 如何工作

四个阶段，每个阶段产出的是证据，而不是断言。

**1. 描述。** 你指定模板、端口和需要的传输模块。在写入任何文件之前，
请求的特性会先与你**实际拥有**的 libuvcpp 构建做比对 —— 依据是它生成的
`uvcpp_config.h` 和已安装的头文件，绝不从版本号推断。两个同为 1.7.0 的构建，
在是否编入 HTTP/3 上可能截然不同，所以版本号不构成证据。

**2. 生成。** uvp 写出一个完整的 CMake 工程。当请求的模块缺失时，
生成的 `main.cpp` 会带上一段 `#if` 守卫，直接点名需要哪条 CMake 选项来重建
libuvcpp —— 于是失败变成一行可读的错误，而不是 libuvcpp 自身头文件里
一连串未知标识符的报错。

**3. 构建并运行。** CMake 的输出会被解析成结构化诊断，并标注产生它的阶段，
因此头文件错误与链接错误可以区分开。服务在监管下启动，
只有当就绪探针得到应答时才算就绪 —— 绝不用固定 sleep 代替。
`ready` 字段会说明是探针成功，还是超时了。

**4. 请求并报告。** 请求通过真实 socket 发出，断言针对真实响应求值，
最终结果是一个验证包：只有当每一个**被尝试过**的步骤都成功时，
它的状态才是 `verified`。任何被跳过的部分都会变成一条带原因的残余未知项。
覆盖不完整一律报告为 `unknown`，绝不报成 `complete`。

最后这条规则塑造了其余一切。一个明明没去看却说"已验证"的工具，
比一个什么都不说的工具更糟。

## uvp 能做什么

| 任务                                             | 工具                                    |
| ------------------------------------------------ | --------------------------------------- |
| 检查工具链以及存在哪些 libuvcpp 模块             | `uvp_doctor`                            |
| 生成可编译的工程（7 个模板）                     | `uvp_workspace_create`                  |
| 用 CMake 配置并编译                              | `uvp_build`                             |
| 启动服务，并等待它真正能应答                     | `uvp_run`、`uvp_run_stop`               |
| 发起 HTTP/1.1、HTTP/2 与 HTTP/3 请求，并报告 TLS | `uvp_http_request`                      |
| 探测 WebSocket 端点                              | `uvp_websocket_probe`                   |
| 发送 SOAP 信封并读取应答                         | `uvp_soap_call`                         |
| 测量吞吐与延迟分位数                             | `uvp_load_test`                         |
| 录制一段会话中的请求往来，供之后读取             | `uvp_capture_start`、`uvp_capture_read` |
| 把录制的会话对着一个活动目标重放                 | `uvp_capture_replay`                    |
| 针对已录制的请求往来求值断言                     | `uvp_assert_exchange`                   |
| 把以上全部作为一次托管流程执行                   | `uvp_verify`                            |
| 对比两份验证报告，看清到底哪里变了               | `uvp_bundle_diff`                       |

模板：`hello-http`、`rest-api`、`websocket-echo`、`websocket-test`、`soap-service`、
`static-files`、`http3-service`。

特性：`tls`、`http2`、`http3`、`grpc`、`websocket`、`soap`、`db`。
每一项都对应真实存在的 libuvcpp CMake 开关和配置宏；这份映射有完整文档，
包括 libuvcpp 没有对应开关的那两项。

多数模板启动的是 `uvcpp_web_app`；`http3-service` 不是。它写在 `uvcpp_http_server` 之上
—— 1.7.0 里只有这个类型能打开 QUIC 监听 —— 并把同一张路由表同时跑在 TCP 和 HTTP/3 上。

`db` 是唯一会改变模板“存什么”的特性。这些模板里只有 `rest-api` 有存储，所以
`--features db` 把它的内存 map 换成 libuvcpp 的连接池：连接串来自 `UVP_DATABASE_URL`，
指向 SQLite、MySQL 或 PostgreSQL，默认落到工作目录下的一个 SQLite 文件。路由、状态码和
JSON 两者完全一致。在别的模板上声明 `db` 和其它特性一样，只是一条构建要求。

<a id="当前状态"></a>

## 当前状态

uvp 尚未发布 1.0，正在积极建设中。说清楚这意味着什么，比给一个百分比更有用：

**已工作并已验证。** 完整闭环 —— 描述 → 生成 → 构建 → 运行 → 探测 → 证据 ——
在真实的 libuvcpp 1.7.0 安装上对全部模板都通过。生成的工程在存在 CMake
package 时走 `find_package(uvcpp 1.7.0 CONFIG)`，不存在时回退到 `pkg-config`
—— 因为预编译发布包只带后者、不带前者。两条路径都会强制校验版本下限。

CLI 与 MCP 服务端都已经建好，而且两者都是作为**进程**被检验，而不是作为模块：
`tests/boundary/cli/cliContract.test.ts` 运行 CLI，检查它打印出什么、以什么码退出；
`tests/boundary/mcp/mcpSurface.test.ts` 用 stdio 协议与服务端对话。CI 会在干净机器上跑同样的
lane，其中的打包 lane 还会把打包好的 tarball 装进一个空 prefix，再从安装后的副本执行 CLI 的
首批命令和 MCP 握手 —— `files[]` 里漏了文件，就是在这里暴露出来的。每条 CI lane **实际**报告了
什么，记在 [docs/roadmap.md](../roadmap.md) 里，而不是在这里假定：第一次真正跑到测试的 CI run
在那里找到了四个缺陷就停了，而「声称覆盖、但尚未被看到」的 lane，也就在旁边被标成那样。

WebSocket 探测跑在两种栈上：默认是 Node 客户端，另一种是 `uvcpp-probe` —— 一个说
C ABI 的小型 C++ 程序 —— 走 libuvcpp 自己的客户端。第二种栈回答的正是
「uvp 生成的服务，是否和它被生成时所面向的栈说得上话」：
两个都自称符合 RFC 6455 的客户端，可以在 RFC 留白的地方处处不一致。
`uvcpp-probe` 由 `npm run build:native-probe` 构建，是一个独立进程而不是 uvp 加载的模块，
uvp 生成的项目也不依赖它。`tests/toolchain/nativeProbe.test.ts` 会生成一个工程、
用 uvp 找到的 CMake 构建它、启动它，再用真实的二进制探测它：这次运行报告了什么、
这个栈在启动任何进程之前拒绝了什么，以及不带 `--json` 时人看到的是什么。

HTTP/3 也是同一条路，理由也一样：Node 标准库根本没有 HTTP/3 客户端，
所以 `uvp http --http-version 3` 走的是 `uvcpp-probe` 的 QUIC 客户端 ——
libuvcpp 自己的那一个，也就是生成的服务所链接的同一个栈。校验它的也是同一条通道，
所以这里的主张是「同一个实现在线上和自己对得上」，而不是「两个项目对规范的理解一致」。
这条路径有三件事不做，并且会明说而不是猜：`http://` 被拒绝，因为 QUIC 没有明文模式；
`verify_tls` 被拒绝，因为那个客户端只能用交给它的 CA bundle 去校验，否则就不校验；
重定向被拒绝，因为探针只发一次请求。结果会报 `verification: not_checked`，
而不是一个没人检查过的证书；它会列出自己**读过**的响应头，而不是把它们当成全集。
探针的这半个部分只在一种情况下存在：构建它时所用的那份 libuvcpp 带有 HTTP/3 C ABI。
没有它，探针依然能构建、WebSocket 那一半仍然完整，而 `--version` 会说明缺的是哪个 exchange，
以及该改的是那份安装、而不是重新构建探针 —— 所以一台没有 HTTP/3 的机器丢掉的是一种传输，
而不是整套原生栈。见[探针的 HTTP/3 构建判定](../roadmap.md#the-probe-s-http-3-build-gate)。

带数据库的模板是按“存储”而不是按“传输”验证的，而且那条断言就是一次重启：
`tests/toolchain/database.test.ts` 写入一个本次运行独有的值，停掉服务，**再启动一次**，
然后把值读回来 —— 只有这一条能把“真的存下来了”和“答一句 `{"stored":1}` 然后忘掉”
区分开。这条通道跑的是 SQLite，三种方言里唯一不需要额外装东西的那一种；
MySQL 和 PostgreSQL 走的是同一份生成代码、同一条运行时加载驱动的路径，
这里不会声称观察过它们。

**模板包（0.3.0）。** 本版本定义了 `uvp.template/1` 模板包格式，并以应用模块的形式
提供本地 store、确定性搜索、inspect/export 以及有界的密钥/PII 扫描。它还加入了官方
registry [Antruly/uvp-templates](https://github.com/Antruly/uvp-templates) 所用
`uvp.registry/1` 索引的读取客户端。包的 CLI 与 MCP 表面 —— `uvp template ...` 与
`uvp init --template-package` —— 是下一个增量；0.3.0 尚未暴露这些命令，registry 在其
runtime lane 启用前也不会声称任何包已通过构建验证。

**进行中。** Web 工具箱 —— 请求、WebSocket 探测、SOAP 调用、负载测试、抓包、断言 ——
对任何服务都能用，不只对 uvp 生成的。它还缺的是触达范围：工具链 provider 的
**端口（port）**已经定义，`local` provider 已实现；容器与远程 SSH provider 尚未编写。

**发布。** `uvp-agents@0.2.0` 是首个正式发布；`0.3.0` 是当前由 release-please
准备的版本。针对 PR 标题的传统提交门禁与 release-please 工作流
（`.github/workflows/release-please.yml`，由 #177 为 #160 添加）负责生成发布 PR。
发布 PR 上的派生文件仍由维护者手动重新生成，这是 #160 记录在案的决定；
发布工作流由维护者从发布 tag 手动 dispatch。路线图里列出的加固项
只剩下最后一项：`local-msvc` 的 Windows 通道。同一列表里的其余各项已经落地并有检查兜底：
`.github/` 下的每个 action 都固定到 SHA 并在旁边写明release
（`npm run verify:actions`），tarball 无论从工作树打包、从解包到另一路径的副本打包，
还是在 `dist/` 干净重建之后打包，摘要都一致（`npm run verify:pack-reproducible`），
发布产物也带上了机器可读的清单——`sbom.cdx.json`，按 CycloneDX 1.5 描述生产依赖闭包，
在门禁里重新生成并逐字节比对，并随它所要印证的那两个文件一起进 tarball。

计划中的内容见[路线图](../roadmap.md)，已有的测试通道见[测试指南](../testing.md)。

## 实例

一个生成的 `rest-api` 工作区，端到端验证：

```bash
$ uvp verify ./svc --port 8091 --request GET /items/1 \
    --assert status=200 --assert 'json:$.value=first'
```

```
build      succeeded (Debug, unix-makefiles, 4.1s)
libuvcpp   1.7.0 via CMake package (/opt/uvcpp/lib/cmake/uvcpp)
service    listening on 8091, ready after 38ms
exchange   GET /items/1 -> 200 in 2ms
  status_equals 200          pass
  body_json_path_equals $.value=first   pass
status     verified
```

当有步骤被跳过时，它会如实说明：

```
status     partial
unverified http2 responsiveness — requested feature http2 is not present in the
           installed libuvcpp build (UVCPP_NGHTTP2_ENABLE is 0)
```

## 常见问题

<details>
<summary>既然产出是 C++，为什么用 TypeScript？</summary>

因为难的部分不是 C++。难的是契约、代码生成、诊断解析和证据代数 ——
这些都很容易变动，而且在 C++ 里做起来格外痛苦。uvp 产出的 C++ 是普通 C++，
直接链接 libuvcpp；生成工程里没有 uvp 运行时库，也没有任何需要额外安装的东西。

这与让 REA 得以成立的工程分层是一致的：可替换的 TypeScript 控制面，
加上通过一条狭窄且有测试覆盖的边界触达的底层基质。
</details>

<details>
<summary>为什么编译失败不算错误？</summary>

编译失败恰恰说明工具在工作。结果就是诊断信息本身，它们是结构化的、
标注了阶段的、机器可读的。只有**完全无法调用**工具链才算错误。
把这两者混为一谈，会让 Agent 的"修复—重试"循环和"环境损坏"变得无法区分。
</details>

<details>
<summary>这里的 "unknown" 是什么意思？</summary>

意思是 uvp 没有确认答案，并且知道自己没有确认。每一个未能确认的问题都会被记录，
并附带原因 —— `toolchain_missing`、`unsupported_by_build`、`cancelled`、
`out_of_scope` 等等。只有 uvp 确实看完了范围内的全部内容，
覆盖状态才是 `complete`。

真正重要的区别在于："这个构建不支持 HTTP/2" 和
"uvp 无法确定 HTTP/2 是否可用" 是两个不同的结论；
当探针缺失时，只有后者是成立的。
</details>

<details>
<summary>libuvcpp 的版本下限是多少，为什么是 1.7.0？</summary>

生成的工程通过两条发现路径都要求 libuvcpp **1.7.0 或更新版本**。
1.7.0 是功能最完整的版本，也是这些模板经过验证所基于的基线。
它设为下限而非精确锁定，是因为模板用到的 API 在 1.x 系列中一直保持稳定，
锁定只会迫使用户无谓地重建 libuvcpp。

版本过旧时校验会失败，并在消息中写明它实际找到的版本。
</details>

<details>
<summary>uvp 支持 Windows 吗？</summary>

生成的工程支持 —— CMake 模板会针对 MSVC 分支，CMake package 路径在那里也能工作。
uvp 自身的工具链 provider 目前是 local 且偏 POSIX 的；Windows provider 尚未编写。
doctor 会如实报告这一点，而不是假装可以。
</details>

## 文档

- [安装与配置](../installation.md) —— 环境要求、libuvcpp 发现、Agent 配置
- [CLI 与证据](../cli.md) —— 每条命令、输出形态、退出状态
- [MCP 契约](../mcp-contracts.md) —— 生成的工具目录
- [架构](../architecture.md) —— 分层、依赖方向、provider 端口
- [证据模型](../evidence.md) —— observed / derived / unknown，以及如何读懂验证报告
- [libuvcpp 特性映射](../libuvcpp-features.md) —— 每项特性对构建的要求，已针对 1.7.0 验证
- [工具设计](../tool-design.md) —— uvp 工具边界是如何划定的
- [测试](../testing.md) —— 测试层次与真实工具链通道
- [路线图](../roadmap.md) —— 计划中的内容与准入条件
- [发布](../releasing.md) —— 发布流程
- [AGENTS.md](../../AGENTS.md) —— 面向 AI Agent 的仓库规则
- [CONTRIBUTING.md](../../CONTRIBUTING.md) —— 贡献范围与 AI 治理

## 免责声明

uvp 会在你的机器上、以你的权限生成并运行 C++ Web 服务。
生成的服务会监听网络套接字，并在你要求时发起外部请求。
你应当清楚自己在构建什么、它能被谁访问到。详见 [DISCLAIMER.md](../../DISCLAIMER.md)。

## 贡献

我们欢迎缺陷修复、文档改进、测试以及新模板。
uvp 是一个 AI 原生项目，AI 辅助贡献是预期之中的 ——
但每一次贡献仍然必须有一位人类负责人，他读过 diff 并为它负责。
AI 贡献政策见 [CONTRIBUTING.md](../../CONTRIBUTING.md)，
专门针对 Agent 的规则见 [AGENTS.md](../../AGENTS.md)。

## 许可证

[MIT](../../LICENSE)。第三方组件保留各自许可证，
详见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
