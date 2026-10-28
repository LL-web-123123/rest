import { createLogger } from '../logger.mjs';

const logger = createLogger('DeepSeek');

const ERROR_HINTS = {
  400: '请求格式不对（模型名或参数不合法）',
  401: 'API Key 无效或已失效，去 platform.deepseek.com 重新生成',
  402: '账户余额不足，需要充值',
  422: '请求参数不合法',
  429: '请求太频繁，被限流了',
  500: 'DeepSeek 服务端出错',
  503: 'DeepSeek 服务过载，稍后再试',
};

export class DeepSeekError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * DeepSeek 客户端。只做一件事：把一组 messages 变成一句回复。
 * 用的是官方 OpenAI 兼容接口，模型名按 2026-10 官方文档：deepseek-flash / deepseek-v4-pro。
 */
export class DeepSeekClient {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.stats = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, lastError: '' };
  }

  settings() {
    return this.getSettings();
  }

  async #once(messages, settings, { thinking, maxTokens } = {}) {
    const thinkingEnabled = thinking ?? settings.thinking;
    const url = new URL('/chat/completions', settings.baseUrl.endsWith('/') ? settings.baseUrl : `${settings.baseUrl}/`);
    const body = {
      model: settings.model,
      messages,
      max_tokens: maxTokens ?? settings.maxTokens,
      stream: false,
      // 聊天回复要快，思考模式默认是开的，这里显式关掉。
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
    };
    if (!thinkingEnabled) body.temperature = settings.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error?.name === 'AbortError';
      throw new DeepSeekError(
        aborted ? `请求超时（${settings.timeoutMs}ms）` : `网络错误：${error?.message ?? error}`,
        { retryable: true, code: aborted ? 'TIMEOUT' : 'NETWORK' },
      );
    }
    clearTimeout(timer);

    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? detail;
      } catch {
        /* 保持原文 */
      }
      const hint = ERROR_HINTS[response.status] ?? `HTTP ${response.status}`;
      throw new DeepSeekError(`${hint}（HTTP ${response.status}）`, {
        status: response.status,
        detail,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DeepSeekError('返回内容不是合法 JSON', { retryable: true, detail: text.slice(0, 200) });
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new DeepSeekError('返回里没有 content 字段', { retryable: true, detail: text.slice(0, 200) });
    }
    const usage = payload?.usage ?? {};
    this.stats.promptTokens += usage.prompt_tokens ?? 0;
    this.stats.completionTokens += usage.completion_tokens ?? 0;

    // 思考模式开着、max_tokens 又给得少的时候，模型会把额度全烧在推理上，
    // 正文是空字符串。这不是成功，得当成「这次没说话」处理。
    if (!content.trim()) {
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      throw new DeepSeekError(
        reasoningTokens
          ? `思考模式把 ${usage.completion_tokens} 个 token 全用在推理上了，正文是空的。把最大输出 token 调大，或者关掉思考模式`
          : '模型返回了空内容',
        { code: 'EMPTY_CONTENT', retryable: false, detail: String(payload?.choices?.[0]?.finish_reason ?? '') },
      );
    }
    return content;
  }

  async complete(messages, options = {}) {
    const settings = this.settings();
    if (!settings.apiKey) throw new DeepSeekError('还没有填 DeepSeek API Key', { code: 'NO_KEY' });
    this.stats.calls += 1;
    const attempts = Math.max(1, (settings.retries ?? 0) + 1);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#once(messages, settings, options);
      } catch (error) {
        lastError = error;
        this.stats.lastError = error.message;
        // 思考模式把额度烧光了：立刻摘掉思考模式重试一次，别让这条回复白白丢掉。
        if (error.code === 'EMPTY_CONTENT' && (options.thinking ?? settings.thinking)) {
          logger.warn(`${error.message} —— 这次改用非思考模式重试`);
          try {
            return await this.#once(messages, settings, { thinking: false });
          } catch (retryError) {
            lastError = retryError;
            this.stats.lastError = retryError.message;
            break;
          }
        }
        if (!error.retryable || attempt === attempts) break;
        const backoff = 400 * 3 ** (attempt - 1);
        logger.warn(`${error.message}，${backoff}ms 后重试（第 ${attempt}/${attempts} 次）`);
        await sleep(backoff);
      }
    }
    this.stats.failures += 1;
    throw lastError;
  }

  /** 只发一句「你好」，用来验证 Key 和网络。 */
  async ping() {
    const reply = await this.complete([
      { role: 'system', content: '你只回四个字以内。' },
      { role: 'user', content: '回复「通了」两个字。' },
    ]);
    return reply.trim();
  }

  /**
   * 带图说话。frames 是 [{base64, mime}]，用 data URL 内联发过去。
   * 官方文档：图片只能出现在 user 消息里，deepseek-flash 支持 JPEG/PNG/WebP。
   */
  async completeVision(systemPrompt, text, frames) {
    const content = [{ type: 'text', text }];
    for (const frame of frames.slice(0, 8)) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${frame.mime};base64,${frame.base64}`, detail: 'low' },
      });
    }
    return this.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
      // 看一眼就说一句，不需要推理，直接关掉思考模式：快、便宜、不会出现空正文。
      { thinking: false },
    );
  }
}
