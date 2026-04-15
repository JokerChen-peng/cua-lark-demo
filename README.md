
# CUA-Lark：基于视觉大模型与 CV 纠偏的飞书桌面自动化执行工具

**核心技术栈**：TypeScript / Node.js / UI-TARS / OpenCV

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

## 3. CUA-Lark 独家架构方案：矛与盾的结合

基于上述调研以及极低开发成本的诉求，本项目采取**“UI-TARS 决策之矛 + 传统 CV 校验之盾”**的混合架构策略，旨在兼顾开发效率、生态契合度与工业级稳定性。

### 3.1 主干道：UI-TARS 端到端控制 (矛)
全面拥抱字节跳动官方生态。利用 `@ui-tars/sdk` 结合火山引擎的 `Doubao-Seed-2.0-pro` 模型。
该模型原生具备强化学习的“思考（Thought）”机制，能在输出物理坐标前进行内部链式推理，显著提高对飞书复杂界面（如嵌套文档、消息列表）的理解精度。这种端到端的视觉降维彻底替代了繁琐的 Prompt 工程。

### 3.2 校验道：本地 OpenCV 视觉兜底 (盾)
保留在多模态视觉显著性分析上的核心壁垒，构建轻量级本地验证微服务。
在 UI-TARS 决定下发点击坐标至 `@ui-tars/operator-nut-js` 执行物理点击前，先将坐标传入基于 Python/FastAPI 编写的视觉校验器。利用 OpenCV 的静态显著性提取与边缘检测（Canny）+ 形态学闭运算，快速验证目标坐标周围是否存在清晰的交互轮廓。若探查到大面积无特征纯色区域，即判定为模型“坐标幻觉”，主动拦截并触发 Self-Correction 纠偏重试。

---

## 4. 核心技术栈与代码流转

本架构采用了“端到端云脑 + 本地混合验证”的双语微服务设计：

* **调度中枢与业务层 (TypeScript / Node.js)**
    * **CUA SDK**：`@ui-tars/sdk` (自动处理大模型多步状态流转与思维链监听)
    * **物理外设接管**：`@ui-tars/operator-nut-js` (基于 `nut.js` 的内核级键鼠模拟与屏幕捕获)
* **云端推理视觉大脑**
    * **模型选型**：火山引擎 `doubao-1-5-thinking-vision-pro-250428`
* **视觉校验微服务 (Python / OpenCV)**
    * 轻量级 FastAPI 服务，专职处理图像矩阵，提供极速的坐标可靠性审核与基于感知哈希（`imagehash`）的屏幕静止状态侦测。

### 极简执行流演示 (主干道)

```typescript
import { GUIAgent } from '@ui-tars/sdk';
import { NutJSOperator } from '@ui-tars/operator-nut-js';
import * as dotenv from 'dotenv';

dotenv.config();

async function runLarkCUA() {
  // 1. 实例化物理操作器，自动接管截屏与绝对坐标映射
  const operator = new NutJSOperator();

  // 2. 初始化 UI-TARS GUI Agent
  const guiAgent = new GUIAgent({
    model: {
      baseURL: process.env.VOLCENGINE_BASE_URL,
      apiKey: process.env.VOLCENGINE_API_KEY,
      model: 'doubao-1-5-thinking-vision-pro-250428', 
    },
    operator: operator,
    onData: ({ data }) => {
      console.log('[UI-TARS 思考与动作状态]:', data);
    },
    onError: ({ error }) => {
      console.error('[执行受阻]:', error);
    }
  });

  // 3. 一键下达端到端飞书操作指令
  await guiAgent.run('在桌面上找到并打开飞书，搜索联系人张三，并发送消息说“会议纪要已完成”');
}

runLarkCUA();
```

---

## 5. 路线图与工业级演进 (战略落地)

### 阶段一：MVP 闭环达成 (当前已完成)
基于 TypeScript 和火山引擎 API，**已成功跑通“拉起飞书 -> 搜索联系人 -> 发送消息”的端到端自动化闭环。** 验证了官方 SDK 在桌面端的实际控制能力，并在工程上实现了分阶段调试（`find_lark` / `full_flow`）、截屏日志净化与循环上限防死锁控制。

### 阶段二：构筑技术护城河 (面向企业级落地)
1.  **多模态测试断言引擎 (Multimodal Assertion Engine)**：从单一“执行”拓展至“验证”。定义场景级 `pass/fail` 规则，利用视觉模型审查最终界面状态，输出结构化 `result.json` 并归档执行链路截图作为质量审核证据。
2.  **双轨视觉校验网络上线**：将 Python/OpenCV 校验服务作为拦截插件并入主业务流，利用长文本记忆与异常状态回溯策略，大幅提升飞书日历排期、多层嵌套文档等复杂界面的点击命中率。
3.  **数据隐私与轻量化私有部署 (终极形态)**：针对 ToB 企业客户最关心的核心痛点——商业机密数据（聊天记录、内部结构）防泄露，探索脱离公有云 API 的数据闭环方案。计划验证并量化轻量级多模态模型（如 2B-7B 级别的 VLM），使其能够适配普通消费级显卡或企业私有云（VPC）节点。实现局域网内的全离线图像解析与 CUA 执行，构筑商业化落地的最高安全壁垒。
