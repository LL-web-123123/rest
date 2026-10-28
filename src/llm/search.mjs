import { createLogger } from '../logger.mjs';
import { DeepSeekError } from './deepseek.mjs';

const logger = createLogger('联网');

const ERROR_HINTS = {
  400: '搜索参数不合法',
  401: 'API Key 无效或已失效',
  402: '账户余额不足',
  429: '搜索请求太频繁，被限流了',
  500: 'DeepSeek 搜索服务端出错',
  504: '搜索下游超时',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 联网搜索：用 DeepSeek 自己的 Search API（跟聊天用同一个 Key）。
 * POST https://api.deepseek.com/v1/tools/search
 * 按请求计费（$0.75 / 1000 次），失败和空结果不计费。
 */
export class SearchClient {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.stats = { calls: 0, failures: 0, empty: 0, lastError: '' };
  }

  async search(query, { count = 5, needContent = false, oriQuestion } = {}) {
    const settings = this.getSettings();
    if (!settings.apiKey) throw new DeepSeekError('还没有填 DeepSeek API Key', { code: 'NO_KEY' });
    const cleaned = String(query ?? '').trim().slice(0, 128);
    if (!cleaned) throw new DeepSeekError('搜索词是空的', { code: 'EMPTY_QUERY' });

    const url = new URL('/v1/tools/search', settings.baseUrl.endsWith('/') ? settings.baseUrl : `${settings.baseUrl}/`);
    const body = { query: cleaned, count: Math.min(20, Math.max(1, Number(count) || 5)), need_content: Boolean(needContent) };
    if (oriQuestion) body.ori_question = String(oriQuestion).slice(0, 128);

    this.stats.calls += 1;
    const attempts = Math.max(1, (settings.retries ?? 0) + 1);
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(8000, settings.timeoutMs ?? 20000));
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await response.text();

        if (!response.ok) {
          let detail = text.slice(0, 300);
          try {
            detail = JSON.parse(text)?.error?.message ?? detail;
          } catch {
            /* 原文 */
          }
          const hint = ERROR_HINTS[response.status] ?? `HTTP ${response.status}`;
          throw new DeepSeekError(`搜索失败：${hint}`, {
            status: response.status,
            detail,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          });
        }

        const payload = JSON.parse(text);
        const results = Array.isArray(payload?.results) ? payload.results : [];
        if (!results.length) this.stats.empty += 1;
        return results.map((item) => ({
          title: String(item?.title ?? ''),
          url: String(item?.url ?? ''),
          snippet: String(item?.snippet ?? ''),
          summary: String(item?.summary ?? ''),
          content: String(item?.content ?? ''),
          site: item?.site_name ? String(item.site_name) : '',
          date: item?.date ? String(item.date) : '',
          score: Number(item?.rerank_score ?? 0),
        }));
      } catch (error) {
        clearTimeout(timer);
        const aborted = error?.name === 'AbortError';
        lastError = aborted
          ? new DeepSeekError('搜索超时', { code: 'TIMEOUT', retryable: true })
          : error;
        this.stats.lastError = lastError.message;
        if (!lastError.retryable || attempt === attempts) break;
        const backoff = 500 * 2 ** (attempt - 1);
        logger.warn(`${lastError.message}，${backoff}ms 后重试`);
        await sleep(backoff);
      }
    }

    this.stats.failures += 1;
    throw lastError;
  }
}

/** 把搜索结果压成一段给模型看的资料，控制长度别烧 token。 */
export function formatResults(results, { maxItems = 5, maxCharsPerItem = 400 } = {}) {
  if (!Array.isArray(results) || !results.length) return '';
  return results
    .slice(0, maxItems)
    .map((item, index) => {
      const body = (item.summary || item.snippet || item.content || '').replace(/\s+/g, ' ').trim();
      const clipped = body.length > maxCharsPerItem ? `${body.slice(0, maxCharsPerItem)}…` : body;
      const meta = [item.site, item.date ? item.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      return `${index + 1}. ${item.title || '(无标题)'}${meta ? `（${meta}）` : ''}\n   ${clipped || '(没有摘要)'}`;
    })
    .join('\n');
}
