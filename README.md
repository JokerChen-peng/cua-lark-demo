# CUA-Lark：基于视觉大模型与 CV 纠偏的飞书桌面自动化执行工具

**核心技术栈**：TypeScript / Node.js / UI-TARS / OpenCV / Multi-Agent

---

## 1. 行业背景与核心挑战

在 AGI 向虚拟世界延伸的进程中，基于图形用户界面（GUI）的计算机控制代理（Computer-Use Agent, CUA）已成为大厂布局的核心前沿。然而，飞书（Lark）等现代企业级办公软件大量采用高度定制的渲染引擎和 Canvas 容器，导致传统的基于 DOM 树或底层 Accessibility Tree 的自动化测试方案极度脆弱。

**核心痛点：坐标幻觉 (Coordinate Hallucination)**

为了系统性衡量多模态大模型在纯视觉交互下的真实水平，OSWorld 等权威基准测试揭示了一个严峻的现实：即使是顶尖的 VLM，在处理高分辨率截图时，也极难精准输出像素级的绝对 X/Y 坐标。人类在这些任务上的成功率高达 72.36%，而未优化的模型仅在 12.24% 左右徘徊。这种坐标偏移直接导致整个自动化流的崩溃。

---

## 2. 业界标杆架构对比 (SOTA 解析)

在构建 MVP 前，我们对当前业界三大主流多模态 Agent 架构进行了深度对比与扬弃：

| 架构流派 | 典型代表 | 核心破局思路与视觉定位 | 在 Node.js 栈落地的痛点 |
| :--- | :--- | :--- | :--- |
| **感知增强** | Microsoft OmniParser | **外挂中间件**：YOLO 提取 BBox + OCR + VLM 语义描述 | 强依赖 Python 生态与 PyTorch，难以与 Node 进程内存级集成，架构臃肿。 |
| **端到端原生** | ByteDance UI-TARS | **原生模型**：统一多模态 RL 模型，直接输出绝对物理坐标 | 本地算力资源开销大（需 7B/72B 级部署），但云端 API + 官方 SDK 生态极佳。 |
| **云端 API 集成** | Anthropic Computer Use | **云脑 + 执行器**：依赖模型原生视觉能力 + Zoom 补丁机制 | 需要开发者自行实现健壮的跨平台键鼠注入底座与截图轮询机制。 |

---

## 3. CUA-Lark 独家架构方案：四层智能体体系

基于上述调研以及工业级稳定性的诉求，本项目采取**"视觉执行 + CV 校验 + 多 Agent 协作 + 记忆反思"**的四层架构策略，旨在兼顾开发效率、生态契合度与 Agent 核心能力。

### 3.1 执行层：UI-TARS 端到端控制 (矛)

全面拥抱字节跳动官方生态。利用 `@ui-tars/sdk` 结合火山引擎的 `Doubao-Seed-2.0-pro` 模型。

该模型原生具备强化学习的"思考（Thought）"机制，能在输出物理坐标前进行内部链式推理，显著提高对飞书复杂界面（如嵌套文档、消息列表）的理解精度。这种端到端的视觉降维彻底替代了繁琐的 Prompt 工程。

### 3.2 校验层：本地 OpenCV 视觉兜底 (盾)

保留在多模态视觉显著性分析上的核心壁垒，构建轻量级本地验证微服务。

在 UI-TARS 决定下发点击坐标至 `@ui-tars/operator-nut-js` 执行物理点击前，先将坐标传入基于 Python/FastAPI 编写的视觉校验器。利用 OpenCV 的静态显著性提取与边缘检测（Canny）+ 形态学闭运算，快速验证目标坐标周围是否存在清晰的交互轮廓。若探查到大面积无特征纯色区域，即判定为模型"坐标幻觉"，主动拦截并触发 Self-Correction 纠偏重试。

### 3.3 编排层：多 Agent 协作架构 (脑)

单一 Agent 难以应对复杂的企业级场景。我们设计了三层 Agent 协作架构：

```
┌─────────────────────────────────────────────────────────────┐
│                      用户指令输入                            │
│          "帮我给张三发消息说会议纪要已完成"                   │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    🧠 规划 Agent (Planner)                   │
│  • 理解用户意图，拆解成子任务序列                            │
│  • 生成执行计划：[打开飞书] → [搜索联系人] → [发送消息]      │
│  • 评估任务复杂度，决定是否需要人工确认                      │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    ⚙️ 执行 Agent (Executor)                  │
│  • 接收子任务，调用 UI-TARS 或 API 执行                      │
│  • 管理执行状态，处理中间结果                                │
│  • 遇到异常时触发重试或上报                                  │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    ✅ 验证 Agent (Validator)                 │
│  • 检查执行结果是否符合预期                                  │
│  • 视觉断言：最终界面状态验证                                │
│  • 输出结构化执行报告                                        │
└─────────────────────────────────────────────────────────────┘
```

**协作示例：**

```typescript
// 用户指令
const userIntent = "帮我给张三发消息说会议纪要已完成";

// 规划 Agent 拆解任务
const plan = await plannerAgent.plan(userIntent);
// 输出: [
//   { step: 1, action: "open_lark", desc: "打开飞书应用" },
//   { step: 2, action: "search_contact", params: { name: "张三" } },
//   { step: 3, action: "send_message", params: { content: "会议纪要已完成" } }
// ]

// 执行 Agent 逐步执行
for (const task of plan) {
  const result = await executorAgent.execute(task);
  
  // 验证 Agent 检查每步结果
  const validation = await validatorAgent.validate(result);
  if (!validation.pass) {
    // 触发重试或人工介入
    await handleFailure(task, validation.reason);
  }
}
```

### 3.4 记忆层：工作记忆与反思系统 (心)

让 Agent 具备"学习能力"，是区别于传统自动化脚本的核心特征。

**工作记忆 (Working Memory)**

```typescript
interface WorkingMemory {
  currentTask: Task;           // 当前任务
  executedSteps: Step[];       // 已执行步骤
  currentState: ScreenState;   // 当前屏幕状态
  pendingActions: Action[];    // 待执行动作
  errorHistory: Error[];       // 错误历史
}
```

**长期记忆 (Long-term Memory)**

```typescript
interface LongTermMemory {
  frequentContacts: Contact[];     // 常用联系人
  operationTemplates: Template[];  // 操作模板（如"每周五发周报"）
  failurePatterns: Pattern[];      // 失败模式（如"某按钮容易误点"）
  preferenceRules: Rule[];         // 用户偏好规则
}
```

**反思机制 (Reflection)**

```typescript
// 执行失败后，Agent 自动反思
async function reflectOnError(error: Error, context: Context) {
  // 1. 分析失败原因
  const analysis = await analyzeFailure(error, context);
  
  // 2. 更新失败模式库
  await memoryStore.addFailurePattern({
    scenario: context.scenario,
    errorType: error.type,
    solution: analysis.suggestedFix
  });
  
  // 3. 调整后续策略
  return {
    shouldRetry: analysis.retryable,
    alternativeApproach: analysis.alternativeMethod,
    needHumanConfirm: analysis.risky
  };
}
```

### 3.5 决策层：视觉 + API 混合引擎 (智)

纯视觉有不确定性，但飞书有官方 CLI（lark-cli）提供 API 能力。混合决策能兼顾稳定性和灵活性。

```typescript
interface DecisionEngine {
  // 智能选择执行方式
  chooseExecutionPath(task: Task): 'visual' | 'api' | 'hybrid';
}

// 决策规则示例
const decisionRules = [
  // 高精度操作 → 优先 API
  { condition: "发送消息", preferred: "api", reason: "API 更稳定" },
  { condition: "查询日历", preferred: "api", reason: "API 可直接返回结构化数据" },
  
  // 视觉定位操作 → 必须视觉
  { condition: "点击按钮", preferred: "visual", reason: "无 API 可用" },
  { condition: "打开应用", preferred: "visual", reason: "需要桌面级控制" },
  
  // 复杂场景 → 混合
  { condition: "创建文档并填写", preferred: "hybrid", reason: "创建用 API，填写用视觉" }
];
```

**混合执行示例：**

```typescript
async function executeHybrid(task: Task) {
  const decision = decisionEngine.chooseExecutionPath(task);
  
  switch (decision) {
    case 'api':
      // 直接调用 lark-cli
      return await larkCLI.execute(task);
    
    case 'visual':
      // 走 UI-TARS 视觉执行
      return await uiTarsAgent.run(task);
    
    case 'hybrid':
      // 拆分任务，API + 视觉组合
      const docId = await larkCLI.createDocument(task.params);
      return await uiTarsAgent.fillDocument(docId, task.content);
  }
}
```

---

## 4. 核心技术栈与代码流转

本架构采用"端到端云脑 + 本地混合验证 + 多Agent协作"的三层微服务设计：

### 4.1 调度中枢与业务层 (TypeScript / Node.js)

| 组件 | 技术栈 | 职责 |
| :--- | :--- | :--- |
| **Agent Orchestrator** | TypeScript | 多 Agent 调度与状态管理 |
| **Decision Engine** | TypeScript | 视觉/API 混合决策 |
| **Memory Service** | TypeScript + Redis | 工作记忆与长期记忆管理 |
| **CUA SDK** | `@ui-tars/sdk` | 大模型多步状态流转与思维链监听 |
| **物理外设接管** | `@ui-tars/operator-nut-js` | 内核级键鼠模拟与屏幕捕获 |

### 4.2 云端推理视觉大脑

| 组件 | 技术栈 | 职责 |
| :--- | :--- | :--- |
| **规划模型** | 火山引擎 `doubao-pro` | 任务拆解与规划 |
| **执行模型** | 火山引擎 `doubao-seed-2-0-mini` | 视觉理解与坐标输出 |
| **验证模型** | 火山引擎 `doubao-vision` | 执行结果视觉断言 |

### 4.3 视觉校验微服务 (Python / OpenCV)

| 组件 | 技术栈 | 职责 |
| :--- | :--- | :--- |
| **坐标校验器** | OpenCV + FastAPI | 坐标可靠性审核（边缘检测 + 显著性分析） |
| **静止检测器** | imagehash | 屏幕静止状态侦测（判断操作是否完成） |
| **视觉断言器** | OpenCV + Template Matching | 界面状态验证（如"消息已发送"标识检测） |

### 4.4 完整执行流演示

```typescript
import { AgentOrchestrator } from './agents/orchestrator';
import { MemoryService } from './services/memory';
import { DecisionEngine } from './services/decision';
import { UI-TARSAgent } from './agents/executor';
import { LarkCLI } from './services/lark-cli';

async function runCUA(userIntent: string) {
  // 1. 初始化组件
  const orchestrator = new AgentOrchestrator();
  const memory = new MemoryService();
  const decision = new DecisionEngine();
  
  // 2. 规划 Agent 拆解任务
  const plan = await orchestrator.planner.plan(userIntent);
  memory.setWorkingMemory({ plan, executedSteps: [] });
  
  // 3. 逐步执行
  for (const task of plan.steps) {
    // 3.1 决策引擎选择执行方式
    const method = decision.chooseExecutionPath(task);
    
    // 3.2 执行 Agent 执行
    let result;
    if (method === 'api') {
      result = await LarkCLI.execute(task);
    } else {
      result = await UI-TARSAgent.run(task);
    }
    
    // 3.3 验证 Agent 检查结果
    const validation = await orchestrator.validator.validate(result);
    
    if (!validation.pass) {
      // 3.4 反思机制：分析失败原因
      const reflection = await memory.reflectOnError(result.error);
      
      if (reflection.shouldRetry) {
        // 重试
        continue;
      } else if (reflection.needHumanConfirm) {
        // 请求人工确认
        await requestHumanIntervention(reflection);
        break;
      }
    }
    
    // 3.5 更新工作记忆
    memory.addExecutedStep(task, result);
  }
  
  // 4. 输出执行报告
  return orchestrator.generateReport(memory.getWorkingMemory());
}

// 执行
runCUA("帮我给张三发消息说会议纪要已完成");
```

---

## 5. 路线图与工业级演进 (战略落地)

### 阶段一：MVP 闭环达成 ✅ (已完成)

基于 TypeScript 和火山引擎 API，**已成功跑通"拉起飞书 -> 搜索联系人 -> 发送消息"的端到端自动化闭环。**

**验证成果：**
- 官方 SDK 在桌面端的实际控制能力验证
- 分阶段调试（`find_lark` / `full_flow`）实现
- 截屏日志净化与循环上限防死锁控制

### 阶段二：核心能力升级 (4.22 - 5.6，复赛冲刺)

**目标：构建 Agent 核心差异化能力**

| 里程碑 | 内容 | 产出 |
| :--- | :--- | :--- |
| **M1: 多 Agent 架构** | 规划/执行/验证 Agent 协作 | 协作流程图 + 状态流转日志 |
| **M2: OpenCV 校验服务** | 坐标可靠性检测 + 静止检测 | Python 服务 + 对比实验数据 |
| **M3: 场景扩展** | 发消息 → 日历/文档/多维表格 | 多场景 Demo 视频 |
| **M4: 执行报告** | 结构化 result.json + 截图归档 | 可视化执行链路 |

### 阶段三：智能能力深化 (5.6 - 5.14，决赛冲刺)

**目标：体现 Agent 的"学习"与"决策"能力**

| 里程碑 | 内容 | 产出 |
| :--- | :--- | :--- |
| **M5: 记忆系统** | 工作记忆 + 长期记忆 + 反思机制 | 记忆可视化面板 |
| **M6: 混合决策** | 视觉 + API 智能选择 | 决策路径对比实验 |
| **M7: 安全审计** | 敏感操作确认 + 操作日志 | 安全策略配置界面 |

### 阶段四：工业级落地 (决赛后)

**目标：面向企业级场景的完整解决方案**

1. **多模态测试断言引擎**：从单一"执行"拓展至"验证"，定义场景级 `pass/fail` 规则，输出标准化测试报告。

2. **数据隐私与私有部署**：探索轻量级多模态模型（2B-7B VLM），实现局域网内的全离线 CUA 执行，构筑商业化落地的安全壁垒。

3. **插件化生态**：支持用户自定义操作模板、验证规则，构建开放生态。

---

## 6. 项目亮点总结

| 维度 | 传统自动化方案 | CUA-Lark 方案 |
| :--- | :--- | :--- |
| **定位** | 脚本执行工具 | 智能体协作系统 |
| **执行方式** | 单一视觉或API | 视觉+API混合决策 |
| **容错能力** | 失败即终止 | 反思+重试+人工介入 |
| **学习能力** | 无 | 工作记忆+长期记忆+反思 |
| **验证能力** | 无 | 多模态视觉断言 |
| **可扩展性** | 硬编码 | Agent编排+插件生态 |

---

## 7. 快速开始

```bash
# 克隆仓库
git clone https://github.com/JokerChen-peng/cua-lark-demo.git
cd cua-lark-demo

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入火山引擎 API Key

# 运行 Demo
npm run demo
```

---

## 8. 参考资料

- [UI-TARS 官方文档](https://github.com/bytedance/UI-TARS)
- [火山引擎 Doubao 模型](https://www.volcengine.com/docs/82379)
- [飞书 CLI (lark-cli)](https://github.com/larksuite/cli)
- [OSWorld 基准测试](https://os-world.github.io/)
- [Computer-Use Agent 概念](https://cua.ai/)

---

**License**: MIT

**Author**: [JokerChen-peng](https://github.com/JokerChen-peng)
