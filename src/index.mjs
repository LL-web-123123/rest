import { spawn } from 'node:child_process';
import path from 'node:path';
import { CONTEXT_DIR, DATA_DIR, ensureDirs, loadConfig, saveConfig } from './config.mjs';
import { bus, createLogger, setLogLevel } from './logger.mjs';
import { DeepSeekClient } from './llm/deepseek.mjs';
import { SearchClient } from './llm/search.mjs';
import { ContextStore } from './bot/context.mjs';
import { Brain } from './bot/brain.mjs';
import { BotPipeline } from './bot/pipeline.mjs';
import { BotRuntime } from './bot/runtime.mjs';
import { StickerStore } from './bot/stickers.mjs';
import { MemeBook } from './bot/memes.mjs';
import { MemeWiki } from './bot/memewiki.mjs';
import { IdleWatcher } from './bot/idle.mjs';
import { browse, pickBar } from './idle/tieba.mjs';
import { learnStyle } from './idle/learner.mjs';
import { createApp } from './web/server.mjs';

const logger = createLogger('启动');

let config;

function getConfig() {
  return config;
}

function setConfig(next) {
  config = next;
  setLogLevel(next.bot?.debug ? 'debug' : 'info');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

async function main() {
  await ensureDirs();
  try {
    setConfig(await loadConfig());
  } catch (error) {
    logger.error(error.message);
    setConfig(await loadConfig().catch(() => null));
    if (!config) throw error;
  }
  setLogLevel(config.bot?.debug ? 'debug' : 'info');

  const context = new ContextStore({
    dir: CONTEXT_DIR,
    enabled: config.bot.contextEnabled,
    size: config.bot.contextSize,
  });
  const deepseek = new DeepSeekClient(() => getConfig().deepseek);
  const search = new SearchClient(() => getConfig().deepseek);
  const stickers = new StickerStore({ dir: DATA_DIR, logger: createLogger('表情') });
  await stickers.load();
  const brain = new Brain({
    dir: config.bot.brainDir ?? '',
    logger: createLogger('大脑记忆'),
    maxFacts: config.bot.brainMaxFacts ?? 6,
  });
  await brain.reload(true);
  // 热梗库：从人味插件那份挑几条，跟着最新一条消息走
  const memes = new MemeBook({
    file: config.bot?.memeFile || path.join(DATA_DIR, 'memes.json'),
    logger: createLogger('梗库'),
    limit: Number(config.bot?.memeLimit ?? 4),
  });
  await memes.load(true);
  const wiki = new MemeWiki({ dir: DATA_DIR, logger: createLogger('梗百科') });
  await wiki.load();
  const pipeline = new BotPipeline({
    getConfig, deepseek, context, bus, stickers, brain, search, memes, wiki,
    logger: createLogger('大脑'),
  });
  const runtime = new BotRuntime({ getConfig, pipeline, bus, stickers });

  // 没人理的时候，自己去刷贴吧学说话
  const idleWatcher = new IdleWatcher({
    getConfig,
    bus,
    onIdle: async () => {
      const cfg = getConfig();
      const bar = pickBar(cfg.idle?.tiebaBar);
      const result = await browse({
        kw: bar,
        threads: Number(cfg.idle?.threads ?? 4),
        postsPerThread: Number(cfg.idle?.postsPerThread ?? 8),
      });
      const learned = await learnStyle({
        deepseek,
        corpus: result.corpus,
        brainDir: cfg.bot?.brainDir ?? '',
        kw: bar,
      });
      if (brain?.enabled) await brain.reload(true);

      // 学会了就顺手在群里抛个梗（默认开着，界面上 idle.proactiveMeme 可关）
      let meme = null;
      const groupId = String(cfg.idle?.proactiveGroupId ?? '7700774823558988347');
      if (cfg.idle?.proactiveMeme !== false && Math.random() < 0.8) {
        try {
          const item = await wiki.random();
          if (item) {
            const gist = String(item.summary || item.usage || '').replace(/^来源\s*/, '').replace(/\s+/g, ' ').trim();
            const line = `刚翻到个梗「${item.name}」——${gist.slice(0, 46)}`;
            await runtime.sendTo(groupId, line);
            meme = item.name;
            logger.info(`抛了个梗：${item.name}`);
          }
        } catch (error) {
          logger.warn(`抛梗失败：${error.message}`);
        }
      }

      return { ok: learned.ok, bar, threads: result.threads, corpus: result.corpus.length, meme, ...learned };
    },
  });
  pipeline.onActivity = () => idleWatcher.touch();
  idleWatcher.start();

  const port = Number(config.server?.port ?? 8799);
  const { server } = createApp({ getConfig, setConfig, runtime, pipeline, deepseek, context, bus, stickers, brain, search, idleWatcher, memes });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${port}`;
  logger.info(`界面地址：${url}`);
  if (!config.deepseek.apiKey) {
    logger.warn('还没有填 DeepSeek API Key，回复功能用不了（界面上填）');
  }
  if (!config.bot.enabled) {
    logger.info('监听开关默认关闭，只记录消息不回复；确认正常后在界面上打开');
  }
  openBrowser(url);

  void runtime.connect();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    idleWatcher.stop();
    logger.info(`收到 ${signal}，正在收尾…`);
    try {
      await runtime.disconnect();
    } catch {
      /* ignore */
    }
    await context.flush().catch(() => {});
    await saveConfig(getConfig()).catch(() => {});
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exitCode = 1;
});
