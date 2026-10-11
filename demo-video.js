/**
 * DemoVideo 任务插件 —— new-api 任务插件系统最小可运行 demo
 * ---------------------------------------------------------------------------
 * 演示范围（走最短闭环）：
 *   - meta 声明：key / models / usageSchema / 通用任务面
 *   - 提交链路：buildSubmitRequest → parseSubmitResponse
 *   - 查询链路：buildQueryRequest → parseTaskResult
 *   - 用量事实：extractUsage（只报事实，价格由宿主定价表达式算）
 *
 * 本 demo 假想一个最简单的厂商 API：
 *   POST {base}/v1/jobs            {"model","prompt","seconds"}  → {"job_id"}
 *   GET  {base}/v1/jobs/{job_id}                                 → {"status","video_url"}
 *   状态词：pending / processing / done / failed
 *   鉴权头：Authorization: Bearer <key>
 *
 * 本地自测：
 *   go run . plugin lint demo-video.js
 *   go run . plugin test demo-video.js --fixture demo-video.fixture.json
 * ---------------------------------------------------------------------------
 */

export const meta = {
  apiVersion: 1,
  key: "demo-video", // ^[a-z0-9][a-z0-9_-]*$，≤30 字符
  name: "DemoVideo",
  icon: "text:DV", // 无 LobeHub 图标时用文本头像
  description: {
    en: "Demo async text-to-video plugin for the new-api task plugin system",
    zh: "new-api 任务插件系统的异步文生视频演示插件",
  },
  version: "1.0.0",
  author: { name: "demo" },
  models: ["demo-video-v1"], // 全局大小写不敏感唯一
  fetchMode: "per_task",

  // 用量事实 schema：宿主据此生成定价变量。插件只报值，绝不算价格。
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位秒。" },
    },
  },
  usageExamples: [{ label: "std 5s", facts: { seconds: 5 } }],

  // demo 只走通用任务面（POST /v1/tasks/demo-video），不声明 protocols / routes
};

// ===========================================================================
// 提交链路
// ===========================================================================

/**
 * 构建提交请求。ctx 是 DriverContext：
 *   requestBody（规范化请求体） / model（客户端原始模型名） /
 *   upstreamModel（渠道 model_mapping 后的机器身份） / baseUrl / apiKey
 *
 * 口径：上游请求体里的模型字段用 ctx.upstreamModel || ctx.model；
 *       不要在描述符顶层设 model 去覆盖回显。
 */
export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};

  const prompt = String(req.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");

  const seconds = Number(req.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) {
    throw new Error("seconds must be a number between 1 and 60");
  }

  return {
    url: ctx.baseUrl + "/v1/jobs",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + ctx.apiKey,
    },
    body: {
      model: ctx.upstreamModel || ctx.model,
      prompt,
      seconds,
    },
    action: "text_to_video",
  };
}

/**
 * 解析提交响应，必须返回 {taskId}。
 * 可选 taskData：持久化为 Task.Data 快照，查询钩子从 ctx.data 可见。
 */
export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  const id = body.job_id || body.id;
  if (!id) throw new Error(body.message || "missing job id in submit response");
  return { taskId: id, taskData: body };
}

// ===========================================================================
// 查询链路（fetchMode: per_task）
// ===========================================================================

/**
 * 构建查询请求。ctx 是 TaskQueryContext —— 注意没有 requestBody：
 *   taskId（上游任务 ID）/ publicTaskId（网关任务 ID）/
 *   baseUrl / apiKey / data（Task.Data 最新快照）/ state（插件私有状态）
 */
export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl + "/v1/jobs/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey },
  };
}

/**
 * 解析一次轮询结果 → NormalizedTaskResult。
 * 状态映射必须显式落表；不认识的状态一律返回 UNKNOWN，
 * 绝不用 || "IN_PROGRESS" 兜底（否则死任务要等 20 次失败 / 24h 超时才终结）。
 */
export function parseTaskResult(ctx, body) {
  const statuses = {
    pending: "QUEUED",
    processing: "IN_PROGRESS",
    done: "SUCCESS",
    failed: "FAILURE",
  };
  const status = statuses[body.status];
  if (!status) {
    return { status: "UNKNOWN", reason: "unknown job status: " + String(body.status || "") };
  }

  const result = { status };
  if (status === "FAILURE") {
    result.reason = String(body.error || "job failed");
  }
  if (status === "SUCCESS" && body.video_url) {
    result.url = String(body.video_url);
  }
  return result;
}

// ===========================================================================
// 用量事实（只报事实，不算价格）
// ===========================================================================

/**
 * 提交阶段用量。ctx.usagePurpose === "billing_ratios" 时返回 null，不参与比率推导。
 * 没有 token 类用量 → 不需要 extractUsageOnComplete。
 */
export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const req = ctx.requestBody || {};
  return { seconds: Number(req.seconds) || 5 };
}
