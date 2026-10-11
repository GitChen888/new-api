/**
 * AcmeVideo 任务插件（示例成品）
 * ---------------------------------------------------------------------------
 * 本文件是《任务插件操作手册.md》第 11 章的完整代码，可直接用于学习与改造。
 *
 * 它是一个"单文件同步 ECMAScript 模块"，由 new-api 宿主加载：
 *   - 宿主负责：HTTP 连接、持久化、重试、轮询调度、鉴权、计费与结算；
 *   - 本插件只负责：把请求变换成宿主能发的描述符、把响应解析成规范状态、上报用量事实。
 *
 * 禁用能力（宿主不会提供）：fetch、文件系统、require、import、async/await、环境变量。
 * 可用全局：utils.{unixNow,jwtSignHS256,hmacSHA256,base64,base64URL,base64URLDecode,uuid,volcSignV4}、console.log。
 *
 * 本地自测：
 *   new-api plugin lint acmevideo.js
 *   new-api plugin test acmevideo.js --fixture golden.json
 * ---------------------------------------------------------------------------
 */

export const meta = {
  apiVersion: 1,
  key: "acmevideo", // ^[a-z0-9][a-z0-9_-]*$，且不超过 30 字符
  name: "AcmeVideo",
  icon: "text:AV", // 无对应图标名时用文本头像；也可写 LobeHub 图标名如 "Sora.Color"
  description: {
    en: "AcmeVideo async text-to-video and image-to-video generation",
    zh: "AcmeVideo 异步文生视频与图生视频",
  },
  version: "1.0.0", // 必须是合法 semver；同 key 改源码必须升版本
  author: { name: "你的名字" }, // name 必需；url 若填写必须是绝对 HTTP(S) 地址
  models: ["acme-v1", "acme-v1-turbo"], // 全局大小写不敏感唯一
  fetchMode: "per_task", // 每个任务单独轮询；批量平台用 "batch"

  // usageSchema 声明"用量事实"的字段与单位。宿主据此生成定价变量，
  // 插件只上报值，绝不计算价格。
  usageSchema: {
    seconds: {
      type: "number",
      unit: "second", // second | count | token | credit
      description: { en: "Requested video duration in seconds.", zh: "请求的视频时长，单位秒。" },
    },
    credits: {
      type: "number",
      unit: "credit",
      description: {
        en: "AcmeVideo credits reported by upstream.",
        zh: "上游返回的 AcmeVideo 积分。",
      },
    },
    resolution: {
      enum: ["480p", "720p", "1080p"], // 非数值选择器：只能取枚举值
      description: { en: "Requested output resolution.", zh: "请求的输出分辨率。" },
    },
  },

  // 展示用的规格样例（纯展示，绝不影响计费）。
  // credits 填 0 是因为本插件不预估厂商积分，实际值由上游完成响应给出；
  // 但 schema 完整向量要求每个声明键都必须出现。
  usageExamples: [
    { label: "v1 5s 720p", facts: { seconds: 5, credits: 0, resolution: "720p" } },
    { label: "turbo 3s 480p", facts: { seconds: 3, credits: 0, resolution: "480p" } },
  ],

  // 声明接入哪些宿主协议。
  // - openai_responses 有模式，必须对象形式并显式 supports；
  // - openai_video 无模式，可裸字符串。
  protocols: [
    { name: "openai_responses", supports: ["stream", "sync", "background"] },
    "openai_video",
  ],
};

// ===========================================================================
// 常量与小工具
// ===========================================================================

const RESOLUTIONS = ["480p", "720p", "1080p"];

function trimmed(value) {
  return String(value || "").trim();
}

// 统一分辨率口径：非法输入一律回落到 720p。
function normalizeResolution(value) {
  const raw = trimmed(value).toLowerCase();
  return RESOLUTIONS.indexOf(raw) >= 0 ? raw : "720p";
}

// 统一秒数口径：缺省 5 秒，取整。是否合法交给 validateSeconds 判定。
function outboundSeconds(req) {
  const raw = req && (req.seconds !== undefined ? req.seconds : req.duration);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.floor(n);
}

// 厂商约束：整数秒，3–10。
// 错误消息会被宿主脱敏、截断后直接返回给 API 调用方，所以要写成用户可读的句子。
function validateSeconds(seconds) {
  if (!Number.isInteger(seconds) || seconds < 3 || seconds > 10) {
    throw new Error("seconds must be an integer between 3 and 10");
  }
}

// ===========================================================================
// 提交链路
// ===========================================================================

/**
 * 构建"提交任务"请求。
 * ctx: DriverContext —— 含 requestBody / action / model / upstreamModel /
 *      baseUrl / apiKey / files / publicTaskId / originTasks。
 *
 * 注意模型字段的口径：
 *   - 上游请求体里用 ctx.upstreamModel（渠道 model_mapping 之后的机器身份）；
 *   - 不要在描述符顶层设置 model 去覆盖映射别名，宿主要求原样回显。
 */
export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};

  const prompt = trimmed(req.prompt);
  if (!prompt) throw new Error("prompt is required");

  const model = ctx.upstreamModel || "acme-v1";
  const seconds = outboundSeconds(req);
  validateSeconds(seconds);

  const body = {
    model,
    prompt,
    seconds,
    resolution: normalizeResolution(req.resolution || req.size),
  };
  // 图生视频：把图片地址透传给厂商（若走 multipart，这里会是文件占位符）。
  if (req.image) body.image_url = req.image;

  return {
    url: ctx.baseUrl + "/api/v2/generations",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Api-Key": ctx.apiKey, // 厂商鉴权头
    },
    body,
    action: req.image ? "image_to_video" : "text_to_video",
  };
}

/**
 * 解析提交流程的响应，拿到上游任务 ID。
 * 必须返回 {taskId}；可选 taskData（写入持久化快照）、immediate（提交即终态）、state（跨轮询状态）。
 * 厂商把错误放在 HTTP 200 的业务 code 里，这里要显式判定。
 */
export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  if (body.code !== 0) throw new Error(body.message || "acme submit failed");

  const id = body.data && body.data.generation_id;
  if (!id) throw new Error("missing generation_id");

  return { taskId: id, taskData: body };
}

// ===========================================================================
// 查询链路
// ===========================================================================

/**
 * 构建"查询任务"请求。
 * ctx: TaskQueryContext —— 注意这里没有 requestBody；
 *      上游任务 ID 在 ctx.taskId，公开任务 ID 在 ctx.publicTaskId。
 */
export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl + "/api/v2/generations/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Accept: "application/json", "X-Api-Key": ctx.apiKey },
  };
}

/**
 * 解析一次轮询结果，返回规范化状态。
 *
 * 状态映射必须显式落表：无法识别就返回 UNKNOWN。
 * 绝不要用 || "IN_PROGRESS" 兜底——那会让一个已死任务永远"进行中"，
 * 只有等 20 次连续失败或 24 小时超时才会终结。
 */
export function parseTaskResult(ctx, body) {
  const data = (body && body.data) || {};

  const statuses = {
    queued: "QUEUED",
    running: "IN_PROGRESS",
    succeeded: "SUCCESS",
    failed: "FAILURE",
  };
  const status = statuses[data.status];
  if (!status) {
    return {
      status: "UNKNOWN",
      reason: "unknown generation status: " + String(data.status || ""),
    };
  }

  const result = { status };

  // 仅在 0 < 进度 < 100 时上报，避免把 0% / 100% 当成有意义进度。
  const progress = Number(String(data.progress || "").replace("%", ""));
  if (Number.isFinite(progress) && progress > 0 && progress < 100) {
    result.progress = progress + "%";
  }

  if (status === "FAILURE") {
    result.reason = trimmed(data.error) || "generation failed";
  }
  if (status === "SUCCESS") {
    const url = trimmed(data.video_url);
    if (url) result.url = url;
  }

  return result;
}

// ===========================================================================
// 用量事实（只报事实，不算价格）
// ===========================================================================

/**
 * 提交阶段的用量事实。
 * ctx.usagePurpose === "billing_ratios" 时不要参与比率推导，直接返回 null。
 */
export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;

  const req = ctx.requestBody || {};
  return {
    seconds: outboundSeconds(req),
    resolution: normalizeResolution(req.resolution || req.size),
  };
}

/** 可选：从提交响应里补充事实（例如厂商回传的预估积分）。 */
export function extractUsageOnSubmit(ctx, taskData) {
  const data = (taskData && taskData.data) || {};
  const credits = Number(data.estimated_credits);
  if (!Number.isFinite(credits)) return null;
  return { credits: credits };
}

/** 完成阶段的用量事实：用上游实际积分覆盖预估。 */
export function extractUsageOnComplete(_task, _result, body) {
  const data = (body && body.data) || {};
  const credits = Number(data.credits);
  if (!Number.isFinite(credits)) return null;
  return { credits: credits };
}

// ===========================================================================
// 产物与内容代理
// ===========================================================================

// 从持久化的 Task.Data 快照里取产物地址（兼容上游包一层 data 的结构）。
function artifactVideoURL(source) {
  const data = (source && source.data) || {};
  const payload = data.data && typeof data.data === "object" ? data.data : data;
  return trimmed(payload.video_url);
}

/**
 * 列出产物。必须与 buildContentRequest 成对导出，缺一会被拒绝加载。
 * 只返回稳定的 key / type（+可选 mimeType），值从 Task.Data 现算，
 * 不做二次存储，也不把上游地址暴露给客户端。
 */
export function listArtifacts(task) {
  return task.status === "SUCCESS" && artifactVideoURL(task)
    ? [{ key: "video", type: "video" }]
    : [];
}

/**
 * 构建取产物的请求。宿主代理后对客户端暴露的是"签名的能力 URL"，
 * 上游真实地址与鉴权头只存在于这一次代理请求里。
 *
 * 该 URL 的主机必须属于渠道 base host 或 meta.allowedHosts；
 * 若是公开 CDN（无需鉴权），应改为 { url, method, credentialless: true }。
 */
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");

  const url = artifactVideoURL(ctx);
  if (!url) throw new Error("artifact_not_found");

  return {
    url,
    method: ctx.clientRequest.method, // 透传客户端的 GET / HEAD
    headers: { "X-Api-Key": ctx.apiKey }, // 厂商产物需鉴权 → 走代理
  };
}

// ===========================================================================
// 协议面：OpenAI Responses
// ===========================================================================

// 把 Responses 的 input 归一化成 {prompt, images}。
function responsesInput(req) {
  const texts = [];
  const images = [];
  const input = req.input;

  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;

      const content =
        item.content === undefined
          ? [item]
          : Array.isArray(item.content)
            ? item.content
            : [item.content];

      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;

        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") {
          texts.push(part.text);
        }
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }

  return {
    prompt: texts.filter(function (text) { return trimmed(text); }).join("\n"),
    images: images,
  };
}

// 从宿主注入的产物能力 URL 里取视频地址，转义后包成 HTML。
// ctx.artifacts 只在任务 SUCCESS 时注入，且这里的 url 不是上游地址。
function responsesVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");

  const escaped = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

export const protocols = {
  openai_responses: {
    // 必需钩子：把协议请求解码成规范的 submit 意图。
    decodeRequest(ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");

      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) {
        throw new Error("request body must be an object");
      }

      const model = trimmed(req.model);
      if (!model) throw new Error("model is required");

      const input = responsesInput(req);
      const prompt = input.prompt || trimmed(req.prompt);
      if (!prompt) throw new Error("input is required");

      const requestBody = { model, prompt };
      if (Object.prototype.hasOwnProperty.call(req, "seconds")) requestBody.seconds = req.seconds;
      if (Object.prototype.hasOwnProperty.call(req, "size")) requestBody.size = req.size;
      if (input.images.length) requestBody.image = input.images[0];

      return {
        kind: "submit",
        model,
        action: input.images.length ? "image_to_video" : "text_to_video",
        requestBody,
      };
    },

    // stream 模式必需：产出增量事件。靠 previousState 去重，状态没变就不发事件。
    renderEvents(ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };

      if (status === "SUCCESS") {
        const events =
          previousState && previousState.status === status
            ? []
            : [{ type: "output", data: responsesVideoText(ctx) }];
        return { events: events, state: state, done: true };
      }

      if (status === "FAILURE") {
        return {
          events: [
            {
              type: "error",
              code: "task_failed",
              message: task.fail_reason || "task failed",
            },
          ],
          state: state,
          done: true,
        };
      }

      if (previousState && previousState.status === status && previousState.progress === progress) {
        return { events: [], state: state, done: false };
      }

      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },

    // sync / background 模式必需：终态时一次性渲染完整响应（只在 SUCCESS 调用）。
    renderFinal(ctx, _task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: responsesVideoText(ctx),
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ],
        metadata: { vendor: "acmevideo" },
      };
    },
  },
};

// ===========================================================================
// 协议面：OpenAI Video
// ===========================================================================

protocols.openai_video = {
  // 创建：支持 JSON 与 multipart 两种入站形态。
  decodeRequest(ctx) {
    if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) {
      throw new Error("JSON or multipart body required");
    }

    let req;
    if (ctx.body.kind === "json") {
      if (!ctx.body.value || Array.isArray(ctx.body.value)) {
        throw new Error("JSON object required");
      }
      req = Object.assign({}, ctx.body.value);
    } else {
      // multipart：文本字段收进 req；文件字节不会进入 JS，只保留不透明引用。
      req = {};
      const fields = ctx.body.fields || {};
      for (const name of Object.keys(fields)) {
        const values = fields[name] || [];
        if (values.length > 1) throw new Error(name + " must be provided once");
        req[name] = values[0];
      }
      for (const file of ctx.body.files || []) {
        if (file.field !== "input_reference") {
          throw new Error("unexpected file field: " + file.field);
        }
      }
    }

    const seconds = outboundSeconds(req);
    validateSeconds(seconds);
    req.seconds = seconds;
    req.resolution = normalizeResolution(req.resolution || req.size);

    const hasImage = Boolean(req.input_reference || req.image);
    return {
      kind: "submit",
      model: ctx.model, // 协议意图回显客户端模型名
      action: hasImage ? "image_to_video" : "text_to_video",
      requestBody: Object.assign({}, req, { model: ctx.model }),
    };
  },

  // 查询：返回 OpenAI Video DTO。宿主会强制 id、清洗 URL 类元数据。
  render(ctx, task) {
    const statuses = {
      NOT_START: "queued",
      SUBMITTED: "queued",
      QUEUED: "queued",
      IN_PROGRESS: "in_progress",
      SUCCESS: "completed",
      FAILURE: "failed",
    };

    const output = {
      id: task.task_id, // 宿主会用公开任务 ID 覆盖
      object: "video",
      model: (task.properties || {}).origin_model_name || "",
      status: statuses[task.status] || "unknown",
      progress: Number(String(task.progress || "0").replace("%", "")),
      created_at: Number(task.created_at || 0),
    };

    const completedAt = Number(task.finished_at || task.updated_at || 0);
    if (completedAt > 0) output.completed_at = completedAt;

    if (task.status === "FAILURE") {
      output.error = {
        code: "video_generation_failed",
        message: "The video generation task failed.",
      };
    }

    return output;
  },
};
