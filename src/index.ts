import "dotenv/config";
import { GUIAgent } from "@ui-tars/sdk";
import { NutJSOperator } from "@ui-tars/operator-nut-js";

/**
 * 必填环境变量读取与校验，避免运行时才出现难排查的空值问题。
 */
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`缺少环境变量: ${name}，请在 .env 中配置。`);
  }
  return value.trim();
}

/**
 * 火山引擎 Ark API Key 基础校验：
 * - 去除常见误配置（引号、空白、Base64 文本）
 * - 明确提示应使用控制台生成的原始 Key
 */
function validateVolcengineApiKey(apiKey: string): void {
  if (apiKey.includes(" ") || apiKey.includes("\n") || apiKey.includes("\r")) {
    throw new Error("VOLCENGINE_API_KEY 含有空白字符，请检查 .env 是否有换行或多余空格。");
  }

  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    throw new Error("VOLCENGINE_API_KEY 不需要包裹引号，请使用原始 Key。");
  }

  const base64Like = /^[A-Za-z0-9+/=]+$/.test(apiKey);
  if (base64Like && !apiKey.startsWith("ark-")) {
    throw new Error(
      "VOLCENGINE_API_KEY 看起来像 Base64 字符串，不是 Ark 原始 API Key。请从火山引擎控制台复制原始 key（通常以 ark- 开头）。"
    );
  }
}

/**
 * 日志净化：去掉超长 Base64/图片字段，避免终端被大段字符串刷屏。
 */
function sanitizeForLog(payload: unknown): unknown {
  const seen = new WeakSet<object>();
  const hiddenKeys = new Set(["imagebase64", "screenshotbase64", "base64", "image"]);

  return JSON.parse(
    JSON.stringify(payload, (key, value) => {
      if (value && typeof value === "object") {
        if (seen.has(value as object)) {
          return "[circular]";
        }
        seen.add(value as object);
      }

      if (hiddenKeys.has(key.toLowerCase())) {
        return "[omitted-binary-data]";
      }

      if (typeof value === "string") {
        // 常见 Base64 超长串，直接隐藏。
        if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value)) {
          return `[omitted-base64 length=${value.length}]`;
        }
        // 非 Base64 的超长文本也截断，避免占屏。
        if (value.length > 400) {
          return `${value.slice(0, 200)} ...[truncated, total=${value.length}]... ${value.slice(-80)}`;
        }
      }

      return value;
    })
  );
}

/**
 * CUA-Lark MVP 主流程：
 * 1) 初始化物理执行器（nut.js）
 * 2) 初始化 GUIAgent（挂载云端模型 + 执行器）
 * 3) 下发精准任务指令并执行
 */
async function runLarkAgent(): Promise<void> {
  const baseURL = getRequiredEnv("VOLCENGINE_BASE_URL");
  const apiKey = getRequiredEnv("VOLCENGINE_API_KEY");
  validateVolcengineApiKey(apiKey);
  const model =
    process.env.VOLCENGINE_MODEL?.trim() ||
    "doubao-1-5-thinking-vision-pro-250428";
  const stage = (process.env.TASK_STAGE || "find_lark").trim().toLowerCase();
  const targetContact = (process.env.TARGET_CONTACT || "张三").trim();
  const messageText = (process.env.MESSAGE_TEXT || "hello world").trim();
  const maxLoopCount =
    Number(process.env.MAX_LOOP_COUNT) ||
    (stage === "find_lark" ? 3 : 12);
  const verboseLog = process.env.LOG_VERBOSE === "1";

  // 物理层执行器：真正接管键盘/鼠标操作
  const operator = new NutJSOperator();

  // UI-TARS Agent：负责视觉理解 + 动作规划，底层动作由 operator 执行
  let lastAgentError: unknown = null;
  const guiAgent = new GUIAgent({
    model: {
      baseURL,
      apiKey,
      model
    },
    operator,
    // 限制最大循环轮数，避免调试阶段出现“无限调用”
    maxLoopCount,
    // onData：打印思考过程与动作意图，便于观察内部链路
    onData: ({ data }) => {
      const payload = verboseLog ? data : sanitizeForLog(data);
      console.log("[onData]", JSON.stringify(payload, null, 2));
    },
    // onError：统一捕获执行链路中的异常，方便快速定位问题
    onError: ({ data, error }) => {
      lastAgentError = error;
      const payload = verboseLog ? data : sanitizeForLog(data);
      console.error("[onError:data]", JSON.stringify(payload, null, 2));
      console.error("[onError:error]", error);
    }
  });

  // 分阶段调试：默认先只做第一步“找到并激活飞书”
  let prompt = "";

  if (stage === "find_lark") {
    prompt = `
你是一个严格执行桌面自动化的助手。请只执行一个目标：找到并激活“飞书（Lark）”桌面应用窗口。

执行要求：
- 只允许做与“找到并激活飞书窗口”相关的操作。
- 若飞书已在前台，只需确认窗口已激活并立刻结束任务。
- 若飞书不在前台，切换到飞书窗口并立刻结束任务。
- 严禁输入任何文字、点击搜索框、打开联系人或发送消息。
`.trim();
  } else if (stage === "full_flow") {
    prompt = `
你是一个严格执行桌面自动化的助手。请在当前屏幕中执行以下步骤，不要做任何无关操作：
1. 找到并激活“飞书（Lark）”桌面应用窗口（若未在前台则切到前台）。
2. 点击飞书顶部搜索框。
3. 输入：${targetContact}
4. 在搜索结果中点击对应联系人，进入聊天窗口。
5. 在聊天输入框中输入：${messageText}
6. 点击发送按钮或使用正确快捷键发送消息。

执行风格（速度优先）：
- 减少等待和重复确认，优先直接执行下一步。
- 每步最多重试 1 次；单次等待不超过 1 秒。
- 一旦确认进入目标聊天窗口，立即发送并结束任务，不做额外复查。
- 输入联系人后，优先选择最匹配的第一个联系人结果。
- 严禁点击与任务无关的控件；若连续失败则立即停止并结束。
`.trim();
  } else {
    throw new Error(`不支持的 TASK_STAGE: ${stage}。可选值: find_lark | full_flow`);
  }

  console.log(
    `CUA-Lark 启动，当前阶段: ${stage}，目标联系人: ${targetContact}，消息: ${messageText}，最大循环: ${maxLoopCount}`
  );
  await guiAgent.run(prompt);
  if (lastAgentError) {
    throw new Error("GUIAgent 执行失败，请查看上方 [onError:error] 日志。");
  }
  console.log("任务执行完成。");
}

runLarkAgent().catch((error) => {
  console.error("runLarkAgent 执行失败：", error);
  process.exitCode = 1;
});
