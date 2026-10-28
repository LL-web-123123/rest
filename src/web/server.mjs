import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { publicConfig, saveConfig, ROOT } from '../config.mjs';
import { createLogger, recentLogs } from '../logger.mjs';

const logger = createLogger('界面');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createApp({ getConfig, setConfig, runtime, pipeline, deepseek, context, bus, stickers, brain, search, idleWatcher, memes }) {
  const sseClients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  for (const name of ['log', 'message', 'reply', 'state', 'api-error']) {
    bus.on(name, (data) => broadcast(name, data));
  }

  function statePayload() {
    return {
      config: publicConfig(getConfig()),
      runtime: runtime.publicState(),
      bot: pipeline.snapshot(),
      deepseek: deepseek.stats,
      search: search?.stats ?? {},
      stickerCount: stickers?.count ?? 0,
      brain: brain?.status() ?? { enabled: false },
      memes: memes?.stats() ?? { ready: false, count: 0 },
      idle: idleWatcher?.status() ?? { enabled: false },
      logs: recentLogs(120),
    };
  }

  async function applyConfig(patch) {
    const merged = { ...getConfig() };
    for (const section of ['deepseek', 'bot', 'server', 'media', 'antiSpam', 'idle']) {
      if (patch?.[section] && typeof patch[section] === 'object') {
        merged[section] = { ...merged[section], ...patch[section] };
      }
    }
    // apiKey 传空字符串表示「不改」，传 null 表示「清掉」，避免界面每次保存都把 Key 清空。
    if (patch?.deepseek && Object.prototype.hasOwnProperty.call(patch.deepseek, 'apiKey')) {
      if (patch.deepseek.apiKey === null) merged.deepseek.apiKey = '';
    }
    if (!merged.deepseek.apiKey) {
      const existing = getConfig().deepseek.apiKey;
      if (patch?.deepseek?.apiKey !== null) merged.deepseek.apiKey = existing;
    }
    merged.deepseek.maxTokens = clampInt(merged.deepseek.maxTokens, 32, 4096, 220);
    merged.deepseek.timeoutMs = clampInt(merged.deepseek.timeoutMs, 3000, 120000, 30000);
    merged.deepseek.retries = clampInt(merged.deepseek.retries, 0, 5, 2);
    merged.deepseek.temperature = Math.min(2, Math.max(0, Number(merged.deepseek.temperature) || 1));
    merged.bot.maxChars = clampInt(merged.bot.maxChars, 8, 500, 60);
    merged.bot.replyCooldownSec = clampInt(merged.bot.replyCooldownSec, 0, 3600, 45);
    merged.bot.groupCooldownSec = clampInt(merged.bot.groupCooldownSec, 0, 600, 20);
    merged.bot.maxRepliesPerHour = clampInt(merged.bot.maxRepliesPerHour, 1, 200, 15);
    merged.bot.contextSize = clampInt(merged.bot.contextSize, 0, 1000, 12);
    merged.bot.activeProbability = Math.min(1, Math.max(0, Number(merged.bot.activeProbability) || 0));
    merged.bot.maxVideoWatchesPerHour = clampInt(merged.bot.maxVideoWatchesPerHour, 0, 60, 6);
    merged.bot.maxImageLooksPerHour = clampInt(merged.bot.maxImageLooksPerHour, 0, 60, 10);
    merged.bot.maxSearchesPerHour = clampInt(merged.bot.maxSearchesPerHour, 0, 100, 8);
    merged.bot.searchCount = clampInt(merged.bot.searchCount, 1, 20, 5);
    merged.bot.memeLimit = clampInt(merged.bot.memeLimit, 0, 8, 4);
    merged.media.frames = clampInt(merged.media.frames, 1, 8, 4);
    merged.media.maxBytes = clampInt(merged.media.maxBytes, 1048576, 209715200, 41943040);
    merged.media.ffmpegPath = String(merged.media.ffmpegPath ?? '');
    merged.antiSpam.windowSec = clampInt(merged.antiSpam.windowSec, 2, 600, 10);
    merged.antiSpam.maxMessages = clampInt(merged.antiSpam.maxMessages, 2, 200, 8);
    merged.antiSpam.sameTextCount = clampInt(merged.antiSpam.sameTextCount, 2, 100, 7);
    merged.antiSpam.sameTextWindowSec = clampInt(merged.antiSpam.sameTextWindowSec, 5, 3600, 60);
    merged.antiSpam.maxActionsPerHour = clampInt(merged.antiSpam.maxActionsPerHour, 0, 100, 10);
    merged.idle.idleMinutes = clampInt(merged.idle.idleMinutes, 1, 600, 5);
    merged.idle.minIntervalMinutes = clampInt(merged.idle.minIntervalMinutes, 1, 1440, 30);
    merged.idle.threads = clampInt(merged.idle.threads, 1, 10, 4);
    merged.idle.postsPerThread = clampInt(merged.idle.postsPerThread, 1, 20, 8);
    merged.idle.tiebaBar = String(merged.idle.tiebaBar ?? '').trim().slice(0, 120) || '孙笑川';
    merged.antiSpam.protectedUids = Array.isArray(merged.antiSpam.protectedUids)
      ? merged.antiSpam.protectedUids.map(String).filter(Boolean)
      : [];
    merged.bot.groupWhitelist = Array.isArray(merged.bot.groupWhitelist)
      ? merged.bot.groupWhitelist.map(String)
      : [];
    merged.bot.ownerUids = Array.isArray(merged.bot.ownerUids)
      ? merged.bot.ownerUids.map(String).filter(Boolean)
      : [];
    setConfig(merged);
    await saveConfig(merged);
    context.configure({ enabled: merged.bot.contextEnabled, size: merged.bot.contextSize });
    brain?.configure({ dir: merged.bot.brainDir ?? '', maxFacts: merged.bot.brainMaxFacts });
    if (brain?.enabled) await brain.reload(true);
    if (merged.deepseek.thinking && merged.deepseek.maxTokens < 512) {
      logger.warn(`思考模式开着，但最大输出只有 ${merged.deepseek.maxTokens} 个 token，很容易全烧在推理上、正文变空。建议调到 800 以上，或者关掉思考模式`);
    }
    logger.info('设置已保存');
    broadcast('state', runtime.publicState());
    return merged;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    try {
      if (req.method === 'GET' && route === '/api/state') {
        return json(res, 200, statePayload());
      }

      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return undefined;
      }

      if (req.method === 'POST' && route === '/api/config') {
        const body = await readBody(req);
        const merged = await applyConfig(body);
        return json(res, 200, { ok: true, config: publicConfig(merged) });
      }

      if (req.method === 'POST' && route === '/api/bot/enable') {
        const body = await readBody(req);
        const merged = await applyConfig({ bot: { enabled: Boolean(body.enabled) } });
        logger.info(merged.bot.enabled ? '监听与回复已开启' : '监听已暂停（仍会记录消息）');
        return json(res, 200, { ok: true, enabled: merged.bot.enabled });
      }

      if (req.method === 'POST' && route === '/api/connect') {
        void runtime.connect();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/disconnect') {
        await runtime.disconnect();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && route === '/api/members') {
        const groupId = url.searchParams.get('groupId');
        if (!groupId) return json(res, 400, { ok: false, error: '没有给群 id' });
        const members = await runtime.listMembers(groupId, url.searchParams.get('q') ?? '');
        return json(res, 200, { ok: true, count: members.length, members });
      }

      if (req.method === 'POST' && route === '/api/groups/refresh') {
        const groups = await runtime.refreshGroups();
        return json(res, 200, { ok: true, groups });
      }

      if (req.method === 'POST' && route === '/api/sms') {
        const body = await readBody(req);
        const ok = await runtime.submitSmsCode(body.code ?? '');
        return json(res, 200, { ok });
      }

      if (req.method === 'POST' && route === '/api/test-search') {
        const body = await readBody(req);
        const query = String(body.query ?? '').trim() || 'DeepSeek 最新模型';
        const started = Date.now();
        const results = await search.search(query, { count: 5 });
        return json(res, 200, {
          ok: true,
          ms: Date.now() - started,
          query,
          count: results.length,
          results: results.map((item) => ({
            title: item.title, url: item.url, site: item.site, date: item.date,
            snippet: (item.summary || item.snippet).slice(0, 200),
          })),
        });
      }

      if (req.method === 'POST' && route === '/api/test-api') {        const started = Date.now();
        const reply = await deepseek.ping();
        return json(res, 200, { ok: true, reply, ms: Date.now() - started });
      }

      if (req.method === 'POST' && route === '/api/send') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { ok: false, error: '内容为空' });
        if (!body.groupId) return json(res, 400, { ok: false, error: '没有选择群' });
        await runtime.sendTo(String(body.groupId), text);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/send-image') {
        const body = await readBody(req);
        const { groupId, path: filePath } = body || {};
        if (!groupId || !filePath) return json(res, 400, { ok: false, error: '缺少 groupId 或 path' });
        try {
          await runtime.sendImageTo(String(groupId), String(filePath));
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 500, { ok: false, error: error.message });
        }
      }

      if (req.method === 'POST' && route === '/api/send-video') {
        const body = await readBody(req);
        if (!body.groupId) return json(res, 400, { ok: false, error: '没有选择群' });
        if (!body.path) return json(res, 400, { ok: false, error: '没有给文件路径' });
        const out = await runtime.sendVideoTo(String(body.groupId), String(body.path), body.cover ? String(body.cover) : undefined);
        return json(res, 200, out);
      }

      if (req.method === 'POST' && route === '/api/context/clear') {
        const body = await readBody(req);
        if (body.groupId) await context.clear(String(body.groupId));
        else context.clearAll();
        return json(res, 200, { ok: true });
      }

      // 不用登录、不碰真群，喂一条假消息走完整条管线，看它会不会接话、接什么话。
      // 这是调试用，不发送任何东西到抖音。
      if (req.method === 'POST' && route === '/api/simulate') {
        const body = await readBody(req);
        const captured = [];
        const isShare = Boolean(body.share);
        const isImage = Boolean(body.image);
        const event = {
          threadId: String(body.groupId ?? 'sim-group'),
          senderUid: String(body.senderUid ?? 'sim-user'),
          senderSecUid: undefined,
          isMentionMe: Boolean(body.mentioned),
          text: String(body.text ?? ''),
          content: isShare
            ? { kind: 'share' }
            : isImage
              ? {
                kind: 'image',
                image: body.imageResource ?? {
                  originUrls: body.imageUrls ?? [],
                  largeUrls: body.imageUrls ?? [],
                  mediumUrls: body.imageUrls ?? [],
                  thumbUrls: body.imageUrls ?? [],
                },
              }
              : { kind: 'text' },
          group: {
            name: String(body.groupName ?? '模拟群'),
            groupId: String(body.groupId ?? 'sim-group'),
            pickMember: () => ({ role: Number(body.senderRole ?? 0) }),
            async removeMembers(uids) {
              if (body.blockRemoval) return { statusCode: 500, statusMsg: 'mock 拒绝' };
              return { statusCode: 0, statusMsg: 'ok' };
            },
          },
          member: { displayName: String(body.senderName ?? '模拟群友'), uid: String(body.senderUid ?? 'sim-user') },
          serverMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          clientMessageId: undefined,
          work: isShare
            ? {
              id: String(body.workId ?? 'sim-work'),
              title: String(body.title ?? ''),
              getDetail: async () => ({
                workId: String(body.workId ?? 'sim-work'),
                filtered: false,
                detail: body.detail ?? {
                  desc: String(body.title ?? ''),
                  video: { play_addr: { url_list: body.videoUrls ?? [] }, download_addr: { url_list: body.videoUrls ?? [] } },
                  cover: { url_list: body.coverUrls ?? [] },
                },
              }),
              getAccess: async () => ({ workId: 'sim', canShare: true, canDownload: true, media: [] }),
            }
            : undefined,
          async reply(value) { captured.push(value); return { statusCode: 0, statusMsg: 'ok' }; },
          async quote(value) { captured.push(value); return { statusCode: 0, statusMsg: 'ok' }; },
        };
        const result = await pipeline.handle(event);
        return json(res, 200, { ok: true, result, sent: captured });
      }

      if (req.method === 'GET' && route === '/api/logs') {
        return json(res, 200, { logs: recentLogs(Number(url.searchParams.get('limit') ?? 200)) });
      }

      if (req.method === 'POST' && route === '/api/idle/run') {
        if (!idleWatcher) return json(res, 400, { ok: false, error: '空闲计时器没启动' });
        const result = await idleWatcher.run('manual');
        return json(res, 200, { ok: true, result });
      }

      if (req.method === 'GET' && route === '/api/idle') {
        return json(res, 200, { ok: true, status: idleWatcher?.status() ?? { enabled: false } });
      }

      if (req.method === 'GET' && route === '/api/brain') {
        const text = url.searchParams.get('text') ?? '';
        if (brain?.enabled) await brain.reload(true);
        return json(res, 200, {
          ok: true,
          status: brain?.status() ?? { enabled: false },
          facts: brain?.relevantFacts(text) ?? [],
          memes: memes?.stats() ?? { ready: false, count: 0 },
          personaPreview: (brain?.persona ?? '').slice(0, 400),
          recentPreview: (brain?.recent ?? '').slice(0, 400),
        });
      }

      if (req.method === 'POST' && route === '/api/brain/reload') {
        if (!brain?.enabled) return json(res, 400, { ok: false, error: '还没设置大脑目录' });
        await brain.reload(true);
        return json(res, 200, { ok: true, status: brain.status() });
      }

      if (req.method === 'GET' && route === '/api/memes') {
        const text = url.searchParams.get('text') ?? '';
        if (memes) await memes.load();
        return json(res, 200, {
          ok: true,
          status: memes?.stats() ?? { ready: false, count: 0 },
          picked: text ? memes?.relevant(text, Number(getConfig().bot?.memeLimit ?? 4)) ?? [] : [],
          block: memes?.block(text) ?? '',
        });
      }

      if (req.method === 'GET' && route === '/api/stickers') {        return json(res, 200, {
          ok: true,
          count: stickers?.count ?? 0,
          enabledStatus: stickers?.enabledStatus,
          lastError: stickers?.lastError ?? '',
          items: stickers?.list() ?? [],
        });
      }

      if (req.method === 'POST' && route === '/api/stickers/refresh') {
        const account = runtime.account;
        if (!account) return json(res, 400, { ok: false, error: '还没登录' });
        await stickers.refresh(account);
        return json(res, 200, { ok: true, count: stickers.count, items: stickers.list() });
      }

      if (req.method === 'POST' && route === '/api/stickers/send') {
        const body = await readBody(req);
        if (!body.groupId) return json(res, 400, { ok: false, error: '没有选群' });
        if (!body.id) return json(res, 400, { ok: false, error: '没有选表情' });
        await runtime.sendStickerTo(String(body.groupId), String(body.id));
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET') {
        const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
        const file = path.join(PUBLIC_DIR, path.normalize(rel));
        if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: '越界' });
        try {
          const content = await readFile(file);
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(content);
          return undefined;
        } catch {
          return json(res, 404, { ok: false, error: '文件不存在' });
        }
      }

      return json(res, 404, { ok: false, error: '未知接口' });
    } catch (error) {
      logger.error(`界面请求出错 ${req.method} ${route}：${error.message}`);
      return json(res, 500, { ok: false, error: error.message });
    }
  });

  return { server, broadcast };
}

function clampInt(value, min, max, fallback) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
