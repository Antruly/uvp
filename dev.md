# uvp 项目启动文档

> **文档状态**：Draft v0.2  
> **日期**：2026-10-15  
> **项目名**：uvp  
> **一句话定义**：uvp — libuv-powered, AI-native web framework  
> **目标**：创建一个开源项目，让 AI Agent 通过 MCP 协议驱动 libuvcpp 的高性能 Web 能力，从自然语言需求到可运行的 C++ Web 服务。  
> **第一个里程碑**：基于 uvp 快速实现一个 Web 全栈测试开发工具，集成 API 调试、SOAP 调试、抓包分析等能力，将 libuvcpp 的 HTTP/1.1、HTTP/2、WebSocket、TCP/UDP 等能力全部体现为可被 AI 调用的工具。

---

## 目录

1. [项目命名与定位](#一项目命名与定位)
2. [与 REA 的类比](#二与-rea-的类比)
3. [技术架构设计](#三技术架构设计)
4. [开源仓库治理框架](#四开源仓库治理框架)
5. [AI 贡献治理政策](#五ai-贡献治理政策)
6. [社区运维策略](#六社区运维策略)
7. [第一步可执行任务清单](#七第一步可执行任务清单)
8. [给 AI Agent 的执行指令（AGENTS.md 基础）](#八给-ai-agent-的执行指令agentsmd-基础)
9. [风险与应对](#九风险与应对)
10. [下一步行动](#十下一步行动)
11. [附录：命名可用性检查与 README 建议](#十一附录命名可用性检查与-readme-建议)

---

## 一、项目命名与定位

### 1.1 名称：uvp

- **官方写法**：小写 `uvp`，强调时可用 `UVP`
- **含义**：`uv` 来自 libuv，`p` 可解释为 protocol / platform / proxy / performance
- **完整定义**：**uvp — libuv-powered, AI-native web framework**
- **CLI**：`uvp init`、`uvp serve`、`uvp mcp`
- **C++ 命名空间**：`namespace uvp`
- **CMake Target**：`uvp::core`、`uvp::web`、`uvp::mcp`
- **GitHub 仓库**：`uvp` 或 `uvp-framework`
- **GitHub 组织**：`uvp-labs` 或 `uvp-project`
- **MCP Server**：`uvp-mcp`
- **文档站**：`docs.uvp.dev`

### 1.2 命名注意事项

- **UVP 常见含义是 Unique Value Proposition**：搜索时需绑定限定词，如 `libuv`、`MCP`、`AI-native`、`C++`、`web-framework`。
- **Astral 的 `uv` 很火**：需在 GitHub topics 中明确标注 `libuv`、`cpp`、`mcp`、`ai-agent`、`web-framework`，避免被误认为 `uv` 的插件。
- **商标与包名**：商业化前需查 USPTO、EUIPO、CNIPA；建仓前检查 npm、PyPI、Conan、vcpkg、GitHub 仓库名占用情况。

### 1.3 一句话定位

**让 AI Agent 通过自然语言需求，直接生成基于 libuvcpp 的高性能 C++ Web 服务代码。**

### 1.4 第一个里程碑：Web 全栈测试开发工具

**目标**：基于 uvp 快速构建一个 Web 测试开发工具，集成 Postman（API 调试）、SOAP 调试、抓包分析等能力，将 libuvcpp 的 HTTP/1.1、HTTP/2、WebSocket、TCP/UDP 等能力全部体现为可被 AI 调用的工具。这个工具既是框架的第一个验证案例，也是面向用户的第一个实际价值交付。

---

## 二、与 REA 的类比

| 维度     | REA                                                  | uvp                                                     |
| :------- | :--------------------------------------------------- | :------------------------------------------------------ |
| 核心模式 | 将逆向工具（Ghidra/IDA）包装为 MCP 契约，AI 驱动分析 | 将 Web 框架能力（libuvcpp）包装为 MCP 契约，AI 驱动开发 |
| 目标用户 | 需要理解软件实现的开发者                             | 需要快速构建高性能 Web 服务的开发者                     |
| 关键贡献 | 证据链路 + 跨工具调查状态保持                        | 代码生成模板 + 运行时验证 + 性能保障                    |
| 交付物   | findings + evidence + unknowns                       | 可编译代码 + 测试用例 + 性能报告                        |

REA 的核心工程方法论是：**契约先行（contracts 层独立）→ provider 可换 → 验证 lane 真实化 → 交付物同时服务 CLI 与 MCP**。uvp 的架构将沿用这一方法论。

---

## 三、技术架构设计

### 3.1 三层架构

#### 第一层：底层驱动层（libuvcpp + 扩展）

直接使用 libuvcpp 作为底层引擎。libuvcpp 在保留 libuv 高性能与原有语义的前提下，扩展了内存池、Net、Web、SSL 等模块，提供了 RAII 资源管理、`std::function` 回调，以及面向 TCP、UDP、HTTP、WebSocket 的高级客户端/服务端抽象。HTTP/2 已通过 nghttp2 集成，HTTP/3 在路线图中。

需要做的扩展工作：

- 补充 HTTP/3（基于 quiche 或 ngtcp2）
- 增加可观测性接口（metrics、tracing hooks）
- 封装 gRPC 支持层（基于 nghttp2）

#### 第二层：抽象 API 层（MCP Tool Server）

这是框架的核心。将 libuvcpp 的能力组织为一组**对 AI 友好的、声明式的 MCP 工具**。每个工具需要有清晰的 JSON Schema 描述、输入输出定义和使用示例。

工具分类草案：

| 类别       | 工具示例                                              | 底层映射            |
| :--------- | :---------------------------------------------------- | :------------------ |
| 服务器管理 | `create_http_server`, `configure_tls`, `enable_http2` | `uvcpp_http_server` |
| 路由       | `register_route`, `register_middleware`               | 路由注册            |
| 处理器     | `generate_handler`（AI 生成处理函数体）               | 模板 + AI 代码      |
| 客户端     | `send_request`, `open_websocket`                      | `uvcpp_http_client` |
| 抓包/代理  | `start_proxy`, `capture_traffic`                      | TCP + SSL 中间层    |
| 测试       | `assert_response`, `load_test`                        | 测试运行器          |

每个工具遵循 MCP 规范，通过 stdio 或 Streamable HTTP 暴露，AI Agent（Claude Code、Cursor 等）可以直接发现和调用。Cortex 框架的做法值得参考：它通过 MCP 让 AI Agent 获得对应用中每个模块、实体、API 端点和事件的结构化访问能力，每个声明同时是 REST 路由、OpenAPI operation 和 MCP 工具。

#### 第三层：AI 交互层（Prompt + Workflow）

提供高质量的 Prompt 模板和 AGENTS.md 指引，引导 AI 将用户需求转化为工具调用序列。关键设计：

- **需求解析模板**：将自然语言需求拆解为「服务器配置 + 路由定义 + 处理器逻辑」
- **代码生成模板**：为处理器函数提供符合 libuvcpp 风格的 C++ 代码骨架
- **验证模板**：自动生成对应的测试用例和验证步骤

### 3.2 代码生成模板示例

```cpp
// template/main.cpp
#include <uvp/web.hpp>

int main() {
    uvp::HttpServer server;
    server.listen("0.0.0.0", 8080);

    // __AI_HANDLER_INSERTION_POINT__

    server.run();
    return 0;
}
```

AI 生成的处理器代码将插入到 `__AI_HANDLER_INSERTION_POINT__` 处。

---

## 四、开源仓库治理框架

### 4.1 许可证与基础文件

- **许可证**：MIT（与 libuvcpp 保持一致）
- **必需文件清单**：

```
├── LICENSE                    # MIT
├── README.md                  # 项目介绍、快速开始、架构图
├── CONTRIBUTING.md            # 贡献指南（含 AI 贡献政策）
├── CODE_OF_CONDUCT.md         # 行为准则
├── GOVERNANCE.md              # 治理模型
├── SECURITY.md                # 安全政策
├── AGENTS.md                  # AI Agent 专用指令文件
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│       ├── ci.yml             # 编译 + 测试
│       ├── ai-pr-gate.yml     # AI 提交门禁
│       └── security-scan.yml  # 安全扫描
└── docs/
    ├── architecture.md        # 架构设计文档
    ├── mcp-tools.md           # MCP 工具参考
    └── roadmap.md             # 路线图
```

### 4.2 治理模型

采用 **BDFL（终身仁慈独裁者）+ 核心维护者** 的轻量治理模型，适合项目早期。核心原则：

- 项目创始人担任 BDFL，拥有最终决策权
- 核心维护者（3-5 人）负责 PR 审查、issue 分类、发布管理
- 社区贡献者通过持续的贡献行为晋升为维护者
- 重大架构变更必须通过 RFC 流程
- 治理规则需明确官员职责、组织架构、投票流程、治理修订规则、贡献者晋升路径、子项目生命周期管理

### 4.3 分支保护规则

- `main` 分支必须通过 CI
- 至少 1 位维护者批准
- 禁止强制推送
- 要求线性历史（squash merge）
- 必须通过 AI PR 门禁（如适用）

---

## 五、AI 贡献治理政策

这是本项目最需要精心设计的部分。AI 贡献治理在全球开源社区已经形成了多种实践模式，需要在**效率**和**质量**之间找到平衡。

### 5.1 行业现状参考

| 项目              | 政策                                                                                                                       | 核心理由                                   |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| **LLVM**          | 允许使用 AI 工具，但必须有人类在环（human-in-the-loop），贡献者对 AI 生成内容负完全责任，需在 commit 中标注 `Assisted-by:` | 审查者期望与人类互动，而非与 AI            |
| **Godot**         | 禁止实质性 AI 生成代码，自主 AI Agent 提交的 PR 自动封禁，但允许有限度的辅助使用（代码补全、正则等）                       | 保护“导师-学习者”关系，AI 无法从反馈中学习 |
| **Gerrit/Google** | 采用 default-deny 模型，AI Review 权限需要显式 opt-in，人类承担全部责任                                                    | 防止 AI 生成的安全报告淹没维护者           |
| **Ghostty**       | 允许 AI 辅助，但要求完全披露工具和使用程度，人类贡献者必须完全理解代码                                                     | 人类对代码负责                             |
| **systemd**       | 引入 AI canary 机制，自动检测未被人类审查的 AI/LLM 贡献                                                                    | 确保审查真实发生                           |

### 5.2 本项目政策：AI-First + Human-Gate

基于行业最佳实践和本项目的特殊性质（**项目本身就是为 AI 设计的**），采用 **“AI-First + Human-Gate”** 模式：

**原则一：AI 是首选工具，但人类是最终责任人。**

每位贡献者（无论人类还是 AI Agent 的操作者）对其提交的全部内容承担完全责任。使用 AI 工具时，贡献者必须：

- 亲自阅读、理解并审查所有 AI 生成的代码
- 能够解释代码的行为、架构决策和潜在风险
- 在 PR 描述中披露 AI 工具的使用范围和程度

**原则二：Agent 不能自主提交 PR，必须有指定的人类发起者。**

禁止任何 AI Agent 在未经人类批准的情况下直接创建 PR、发表评论或修改仓库。LLVM 的政策明确禁止“在没有人类批准的情况下在我们的数字空间中采取行动的 agent”。

**原则三：AI 生成的代码必须通过增强验证。**

| 验证层级     | 要求                                                   |
| :----------- | :----------------------------------------------------- |
| **编译验证** | 必须在 GCC 12+ 和 Clang 16+ 上编译通过                 |
| **内存安全** | 必须通过 AddressSanitizer + UndefinedBehaviorSanitizer |
| **单元测试** | 覆盖率不低于 80%，关键路径 100%                        |
| **集成测试** | 必须通过真实 HTTP 客户端（curl/wrk）验证               |
| **性能基准** | 必须提交与基线对比的 benchmark 数据                    |
| **人工审查** | 至少一位核心维护者逐行审查 AI 生成的代码               |

**原则四：PR 描述必须由人类撰写。**

AI Agent 不得撰写 PR 描述或创建/关闭 PR。人类贡献者必须亲自撰写 PR 描述，解释动机、实现方法、预期影响和开放问题。

**原则五：标签与披露机制。**

- AI 辅助的 PR 必须添加 `ai-assisted` 标签
- AI 生成的代码段落必须在 PR diff 中标注 `[AI-GENERATED]`
- 使用 `Assisted-by: <tool-name>` 的 commit trailer

### 5.3 PR 门禁流程

```
PR 提交
  │
  ├── 自动检查（CI）
  │     ├── 编译验证（GCC + Clang）
  │     ├── Sanitizer 检查
  │     ├── 测试覆盖率
  │     ├── 性能基准对比
  │     └── AI canary 检测（检测未审查的 AI 代码）
  │
  ├── AI 辅助审查（可选）
  │     └── 生成审查建议，但不自动合并或批准
  │
  ├── 人类维护者审查（必须）
  │     ├── 逐行阅读代码
  │     ├── 验证 AI 生成部分的行为正确性
  │     ├── 确认贡献者能解释代码
  │     └── 检查合规性和许可证
  │
  └── 合并决策
        └── 至少 1 位维护者批准 + CI 全绿
```

---

## 六、社区运维策略

### 6.1 起步阶段（0-100 星）

- **目标**：完成 MVP，验证核心价值
- **关键动作**：
  - 发布第一个可用的 MCP Tool Server，支持 `create_http_server` 和 `register_route`
  - 录制一个 3 分钟的演示视频：自然语言描述 → AI 调用工具 → 生成 C++ 代码 → 运行服务
  - 在 Hacker News、Reddit r/cpp、MCP 社区发布

### 6.2 增长阶段（100-1000 星）

- **目标**：建立贡献者社区，扩展工具集
- **关键动作**：
  - 发布 `CONTRIBUTING.md` 和 `AGENTS.md`，明确贡献流程
  - 建立“good first issue”标签，引导新贡献者
  - 每两周发布一次版本，保持节奏
  - 在 README 中展示 MCP 工具的自动生成文档

### 6.3 成熟阶段（1000+ 星）

- **目标**：成为 AI-Native Web 开发的标准框架
- **关键动作**：
  - 建立 RFC 流程
  - 引入更多维护者
  - 与 libuvcpp 上游建立正式合作关系

---

## 七、第一步可执行任务清单

### 任务 0：环境准备

- [ ] 创建 GitHub 仓库（建议名：`uvp` 或 `uvp-framework`）
- [ ] 初始化 README.md 和 LICENSE（MIT）
- [ ] 创建 `.github/` 目录结构
- [ ] 配置 GitHub topics：`libuv`、`cpp`、`mcp`、`ai-agent`、`web-framework`、`uvp`

### 任务 1：MVP — 最小可用的 MCP Tool Server

**目标**：实现一个 MCP Server，暴露 2 个工具，让 AI 能生成并运行一个最简单的 HTTP 服务器。

**具体工作**：

1. **搭建项目骨架**
   - 使用 CMake 作为构建系统
   - 依赖 libuvcpp（通过 CMake FetchContent 或 git submodule）
   - 依赖一个 MCP C++ SDK（如果没有现成的，先用 TypeScript/Python 写 MCP Server 作为 bridge，后续再迁移）

2. **定义第一个 MCP 工具**：`create_http_server`

```json
{
  "name": "create_http_server",
  "description": "创建一个基于 libuvcpp 的 HTTP 服务器实例",
  "inputSchema": {
    "type": "object",
    "properties": {
      "port": { "type": "integer", "description": "监听端口" },
      "host": { "type": "string", "default": "0.0.0.0" },
      "tls": { "type": "boolean", "default": false }
    },
    "required": ["port"]
  }
}
```

3. **定义第二个 MCP 工具**：`register_route`

```json
{
  "name": "register_route",
  "description": "为 HTTP 服务器注册路由处理器",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_id": { "type": "string" },
      "method": { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE"] },
      "path": { "type": "string" },
      "handler_code": { "type": "string", "description": "C++ 处理函数体" }
    },
    "required": ["server_id", "method", "path", "handler_code"]
  }
}
```

4. **实现代码生成模板**
   - 创建一个 C++ 项目模板（`template/` 目录）
   - 包含 libuvcpp 初始化、服务器启动、事件循环
   - 预留 `// __AI_HANDLER_INSERTION_POINT__` 占位符

5. **端到端验证**
   - 在 Claude Code 中配置 MCP Server
   - 输入需求：“创建一个监听 8080 的 HTTP 服务器，GET /hello 返回 JSON {"message": "Hello, AI"}”
   - AI 调用工具 → 框架生成 C++ 代码 → 编译运行 → curl 验证

### 任务 2：治理文件初始化

- [ ] 编写 `CONTRIBUTING.md`（含 AI 贡献政策）
- [ ] 编写 `GOVERNANCE.md`
- [ ] 编写 `AGENTS.md`（AI Agent 专用指令）
- [ ] 编写 `CODE_OF_CONDUCT.md`
- [ ] 编写 `SECURITY.md`
- [ ] 创建 PR/Issue 模板

### 任务 3：CI/CD 门禁

- [ ] 实现 `ci.yml`：编译 + 测试 + Sanitizer
- [ ] 实现 `ai-pr-gate.yml`：AI 辅助 PR 的增强验证
- [ ] 配置分支保护规则：必须通过 CI + 至少 1 位维护者审查

### 任务 4：第一个实际案例 — Web 测试工具

- [ ] 扩展 MCP 工具集：`send_request`、`start_proxy`、`assert_response`
- [ ] 提供 CLI 入口（基于生成的代码）
- [ ] 编写使用文档和示例

---

## 八、给 AI Agent 的执行指令（AGENTS.md 基础）

> **以下内容可直接作为 AGENTS.md 的基础内容。**

```md
# AGENTS.md — AI Agent 工作指令

## 项目概述

uvp 是一个 AI-Native Web 开发框架。AI Agent 通过 MCP 协议驱动 libuvcpp
生成 C++ Web 服务代码。项目本身也是 AI 辅助开发的实践案例。

## 你的角色

你是本项目的 AI 编程助手。你的工作是：

1. 根据用户需求，生成符合 libuvcpp 规范的 C++ 代码
2. 调用 MCP 工具完成服务器配置、路由注册等操作
3. 生成对应的测试用例
4. 验证生成的代码可以编译和运行

## 硬性约束

1. **不得自主提交 PR**：所有代码变更必须由人类贡献者发起 PR
2. **生成代码必须可编译**：必须通过 GCC 12+ 和 Clang 16+ 编译
3. **内存安全**：生成代码必须通过 ASan + UBSan
4. **测试覆盖**：新功能必须有对应的单元测试
5. **披露义务**：在 commit 中使用 `Assisted-by: <your-name>` trailer
6. **PR 描述**：不得代写 PR 描述

## 代码风格

- 遵循 libuvcpp 的 RAII 风格
- 使用 std::function 回调而非裸函数指针
- 所有资源必须有明确的生命周期管理
- 错误处理使用 std::expected 或 Result 模式

## MCP 工具参考

（随项目进展更新）

## 验证流程

1. 生成代码后，自动运行 `cmake --build build`
2. 运行单元测试 `ctest --test-dir build`
3. 运行 Sanitizer 检查
4. 报告编译/测试/性能结果
```

---

## 九、风险与应对

| 风险                                       | 应对策略                                   |
| :----------------------------------------- | :----------------------------------------- |
| AI 生成的 C++ 代码存在内存安全问题         | 强制 ASan/UBSan，关键代码人类逐行审查      |
| MCP 协议生态尚未完全成熟                   | 同时支持 stdio 和 HTTP 两种传输模式        |
| libuvcpp 上游 API 变化                     | 通过适配层隔离，定期同步上游               |
| AI 贡献泛滥导致维护者过载                  | 实施贡献配额（每个贡献者每周最多 3 个 PR） |
| 社区对 AI 生成代码的信任问题               | 增强验证机制 + 透明的标签体系              |
| 命名冲突（UVP = Unique Value Proposition） | 持续绑定限定词，建立独立文档站             |

---

## 十、下一步行动

1. **今天**：创建 GitHub 仓库，提交 README + LICENSE + 治理文件草案
2. **本周**：完成 MVP 的 MCP Tool Server 骨架
3. **两周内**：完成第一个端到端演示（自然语言 → 运行中的 HTTP 服务）
4. **一个月内**：发布 v0.1.0，包含 Web 测试工具的第一个可用版本
5. **持续推进**：扩展工具集，完善治理，建立社区

---

## 十一、附录：命名可用性检查与 README 建议

### 11.1 建仓前可用性检查

```bash
# GitHub 仓库/组织
gh repo view uvp/uvp
gh repo view uvp-labs/uvp

# npm
npm view uvp

# PyPI
pip index versions uvp

# 域名
whois uvp.dev
whois uvp.sh
whois uvp.io
```

如果 `uvp` 被占用，备选优先级：

1. `uvp-framework`
2. `uvp-labs/uvp`
3. `uvp-mcp`
4. `uvforge` / `uvstack` / `uvflow`

### 11.2 README 开头建议

```md
# uvp

**uvp** 是一个 AI-native 的 Web 开发框架。  
它通过 MCP 协议把 libuvcpp 的高性能网络能力暴露给 AI Agent，  
让开发者用自然语言生成可编译、可测试、高性能的 C++ Web 服务。

> uvp = libuv + protocol + platform  
> 不是 libuv 官方项目，而是基于 libuvcpp 的 AI 原生上层框架。
```

### 11.3 命名体系速查

| 层级         | 名称                                             |
| :----------- | :----------------------------------------------- |
| 项目名       | **uvp**                                          |
| 官方写法     | 小写 `uvp`，强调时用 `UVP`                       |
| GitHub 仓库  | `uvp` 或 `uvp-framework`                         |
| GitHub 组织  | `uvp-labs` / `uvp-project`                       |
| CLI          | `uvp`                                            |
| MCP Server   | `uvp-mcp`                                        |
| C++ 命名空间 | `uvp`                                            |
| CMake Target | `uvp::core`、`uvp::web`、`uvp::mcp`              |
| 包名         | Conan/vcpkg: `uvp`                               |
| 文档站       | `docs.uvp.dev`                                   |
| 一句话定义   | **uvp — libuv-powered, AI-native web framework** |

---

> **文档结束。将此文档作为项目仓库的 `docs/vision.md` 或 `docs/getting-started.md` 的基础。AI Agent 可依据第八节的指令开始执行任务 1。**
