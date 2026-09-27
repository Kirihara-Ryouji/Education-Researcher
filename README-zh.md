# Education Researcher：教育研究工作台

本项目基于开源 [BrainPilot](https://github.com/NeuroAIHub/BrainPilot)，把版本化研究记录、来源核对、基础数据分析、报告编写和智能体协作放在同一工作台。**新建智能体会话默认选择教育研究。**需要原有脑科学资源时，可以明确选择“脑科学研究”。

> **请从本仓库源码启动。** 已发布的 `@brainpilot/app` npm 包和 `brainpilot.chat` 属于上游 BrainPilot，尚未包含本仓库的教育领域改动。底层模型由你配置的服务商提供；领域设置不能删除模型的预训练知识。工作流程及边界见[使用指南](EDUCATION-RESEARCH.md)。

[English](README.md) · [快速开始](#快速开始) · [教育研究流程](#教育研究流程) · [方法与资源](#方法与研究资源) · [验证状态](#验证状态) · [上游与许可](#上游项目与署名)

## 本项目能做什么

研究工作台集中保存研究者的决策和支撑材料。智能体可协助探索问题；研究方案、证据主张、分析和报告仍需研究者审阅和接受。

| 环节 | 本仓库已提供的能力 |
| --- | --- |
| 定义研究 | 创建项目，版本化记录研究问题、目的、方法与教育情境。 |
| 核对来源 | 登记来源，上传 PDF、DOCX、TXT、Markdown 文件，检查摘录及其支持的具体论断。 |
| 制定方案与分析 | 审阅并接受研究方案；对数据运行已支持的清洗和描述性分析，保留可追溯版本。 |
| 编写报告 | 基于已接受主张建立报告版本；使用分析结果时一并引用，并检查引用与状态是否仍然有效。 |
| 交给智能体继续 | 从当前已接受方案创建教育会话；生成**尚未发送的草稿**，最多包含 12 条已核对内容、带引文的出版物摘录。 |

例如，可以建立一项关于初中数学形成性反馈的研究，登记干预文献，记录结果和局限，审阅可行的比较方案，再让智能体协助检查尚未解决的问题。这是**操作示例，不是本项目已完成的教育学实证结果**。

## 快速开始

需要 **Node.js 22.13.0 或更新版本**。真实智能体回答还需要一个可用的模型服务商。在本仓库根目录运行：

```sh
npm ci
npm run build
npm run bp -- up
```

打开终端显示的本地地址，在**设置 → 服务商**中添加并启用模型服务商。没有密钥时也可以启动界面，但无法进行真实模型任务。若只想检查界面，可先设置 `BP_MOCK=1`；mock 输出不能用于评价研究能力。

Windows PowerShell 中可先运行 `$env:BP_MOCK = '1'`，再运行 `npm run bp -- up`。前台运行用 `Ctrl+C` 停止。数据默认保存在当前目录的 `./brainpilot`，可用 `BP_DATA_DIR` 或 `--dir` 改变位置。从源码启动 CLI 时，请在仓库根目录执行命令。

`npm install -g @brainpilot/app` 安装的是**上游 BrainPilot**，不是本教育研究版。需要从源码使用容器部署时，可参考 [Docker 文档](packages/docs/content/docs/docker.zh-cn.mdx)；其中上游示例可能需要按本仓库环境调整。

## 教育研究流程

1. 打开**研究工作台**，创建项目和研究，记录教育阶段、场景、研究问题、方法及不确定性。
2. 添加来源与原始文件。核对出版物身份、定位信息、摘录，以及它实际支持的主张；把不确定材料标记为待复核。
3. 编写并接受当前研究方案。研究定义或所引文件版本变化后，审阅并保存新版方案。
4. 如使用数据，先检查缺失与来源，再运行已支持的清洗和描述性分析；接受主张或写入报告前复核结果。
5. 在已接受方案上选择**交给教育研究智能体**。系统打开新的教育会话并准备一份**未发送**的上下文草稿。发送前检查问题、方案、引文和自由文本中是否有可识别学生信息。
6. 核对智能体使用的来源与推理，在工作台中接受或修改证据主张与报告版本。

交接不会附带原始文件、CSV 或参与者记录，也不代表智能体重新验证了所引出版物。具体范围见[教育研究使用指南](EDUCATION-RESEARCH.md)；可按[教育领域验收用例](EDUCATION-EVALUATION.md)在自己的模型服务商上检查输出。

## 方法与研究资源

内置六项教育研究技能，涵盖[证据综述](packages/skills/skills/22_Education/education-evidence-review/SKILL.md)、[研究设计](packages/skills/skills/22_Education/education-study-design/SKILL.md)、[测量](packages/skills/skills/22_Education/education-measurement/SKILL.md)、[质性研究](packages/skills/skills/22_Education/education-qualitative-inquiry/SKILL.md)、[学习分析与隐私](packages/skills/skills/22_Education/learning-analytics-privacy/SKILL.md)、[教育 AI 评价](packages/skills/skills/22_Education/education-ai-evaluation/SKILL.md)。[来源索引](packages/skills/skills/22_Education/AUTHORITATIVE_SOURCES.md)提供可核对的方法与伦理入口，它是**入口清单，并非下载好的教育学论文全文库**。引用研究结论前，仍需核对原文。

研究方向在创建会话时固定：

| 会话 | 可用内置资源 |
| --- | --- |
| **教育研究**（新会话默认） | 教育技能与经过选择的通用技能；原有本地脑科学知识及论文工具不可用。 |
| **脑科学研究**（主动选择） | 原有脑科学方法与已配置的本地知识工具。 |
| **没有方向标记的旧会话** | 为保留原来的上下文，按脑科学会话恢复；要使用教育资源，请新建教育会话。 |

外部 MCP 服务可在**设置 → MCP** 中指定用于教育、脑科学或两者。未标注方向的旧配置继续仅用于脑科学会话，需主动把它开放给教育会话。原有的公共数据集目录与 `KnowledgeBase/` 流水线仍是上游脑科学资源；浏览目录条目不会自动让它成为教育研究回答的证据。

## 数据与使用边界

本地应用按**单用户工作台**设计，研究工作台没有账户登录或多用户权限层。本地进程模式下，智能体可以在电脑上使用本地工具；Docker 沙箱是另一种部署方式。熟悉流程时请先用虚构或适当去标识化的数据。使用真实学生资料前，应先落实机构要求的知情同意、访问控制、去标识化和模型服务商安排。模型凭据应留在本机设置中，避免放入聊天内容或仓库。

领域设置控制提示和可用资源，不会微调或重新训练底层模型。关键方法决定、引文和论断都需要对照原始来源人工核查。

## 验证状态

代码测试已检查教育默认值、旧脑科学会话恢复、内置与外部工具边界、研究工作台交接；最近记录的一次完整构建和网页回归测试也已通过，见[验证记录](EDUCATION-EVALUATION.md)。**尚未用已配置的真实模型服务商评估教育学回答质量。**该文档的 E1–E6 是待运行的验收任务，不是已取得的评测分数。

ALE 与 BrainPilotBench-v0 的公开结果属于**上游 BrainPilot 的脑科学任务**，不能用来证明本教育研究版的效果。历史结果可查看[上游仓库](https://github.com/NeuroAIHub/BrainPilot)和[上游评测页面](https://brainpilot.chat/bench)。

## 架构与开发

本项目是包含 **14 个包**的 TypeScript npm workspace。保留的 `@brainpilot/*` 包名用于标识源码模块，不代表本教育研究版已用这些名称发布。

| 模块 | 主要目录 | 职责 |
| --- | --- | --- |
| 协议 | `packages/protocol` | 会话、研究方向、事件及 API 类型。 |
| 智能体运行时 | `packages/runtime` | 会话、提示、专业智能体、工具、MCP 隔离与轨迹。 |
| 研究后端 | `packages/backend-core` | 研究记录、来源与报告 API、HTTP 服务及运行时编排。 |
| 网页界面 | `packages/web` | 研究工作台、智能体聊天、领域选择及设置。 |
| 方法资源 | `packages/skills` | 教育技能与保留的上游技能。 |
| 启动与配套 | `packages/cli`、`packages/client-cli`、`packages/kb-scripts`、`packages/plugin-*`、`packages/docs` | 本地启动、验证、可选上游知识工具、插件与文档。 |

开发时可运行 `npm run build` 和 `npm test`；网页包另有测试脚本。开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，私下报告安全漏洞见 [SECURITY.md](SECURITY.md)。

## 上游项目与署名

Education Researcher 源自 [NeuroAIHub/BrainPilot](https://github.com/NeuroAIHub/BrainPilot)。上游项目提供多智能体研究平台与 [Graph of Trace](https://aclanthology.org/2026.acl-demo.29/)；其[脑科学论文](https://arxiv.org/abs/2607.15079)、[版本记录](CHANGELOG.md)、案例和评测结果均属于上游工作。本分支目前**没有独立的教育学评测或论文**。引用上游方法或结果时，应署名原作者，不应将其表述为教育学成果。

本项目保留上游的 **[GNU AGPL v3](LICENSE)** 许可证和署名。对本分支的贡献也应遵守该许可证，并在适当场合引用上游工作。
