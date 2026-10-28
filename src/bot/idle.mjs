import { createLogger } from '../logger.mjs';

const logger = createLogger('空闲');

/**
 * 没人理我时的定时器。
 * 只要群里有人说话就重新计时；安静够久了就跑一次 onIdle，跑完等下一次安静。
 */
export class IdleWatcher {
  constructor({ getConfig, onIdle, bus, tickMs = 30000 }) {
    this.getConfig = getConfig;
    this.onIdle = onIdle;
    this.bus = bus;
    this.tickMs = tickMs;
    this.timer = null;
    this.running = false;
    this.lastActivityAt = Date.now();
    this.lastRunAt = 0;
    this.lastResult = null;
    this.runs = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.#tick(); }, this.tickMs);
    this.timer.unref?.();
    logger.info('空闲计时器已启动');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 有人说话就调一下，重新计时。 */
  touch() {
    this.lastActivityAt = Date.now();
  }

  get idleMs() {
    const minutes = Number(this.getConfig().idle?.idleMinutes ?? 5);
    return Math.max(1, minutes) * 60_000;
  }

  get minIntervalMs() {
    const minutes = Number(this.getConfig().idle?.minIntervalMinutes ?? 30);
    return Math.max(1, minutes) * 60_000;
  }

  status() {
    const now = Date.now();
    return {
      enabled: this.getConfig().idle?.enabled !== false,
      idleSeconds: Math.round((now - this.lastActivityAt) / 1000),
      idleMinutes: Number(this.getConfig().idle?.idleMinutes ?? 5),
      nextInSeconds: Math.max(0, Math.round((this.idleMs - (now - this.lastActivityAt)) / 1000)),
      running: this.running,
      runs: this.runs,
      bar: this.getConfig().idle?.tiebaBar ?? '',
      lastResult: this.lastResult,
    };
  }

  async #tick() {
    const config = this.getConfig();
    if (config.idle?.enabled === false) return;
    if (this.running) return;
    const now = Date.now();
    if (now - this.lastActivityAt < this.idleMs) return;
    if (now - this.lastRunAt < this.minIntervalMs) return;
    await this.run('idle');
  }

  /** 手动跑一次（界面按钮 / 测试用）。 */
  async run(reason = 'manual') {
    if (this.running) return { ok: false, reason: 'already-running' };
    this.running = true;
    this.lastRunAt = Date.now();
    this.runs += 1;
    this.bus?.emit('idle', { action: 'start', reason });
    try {
      logger.info(`安静了 ${Math.round((Date.now() - this.lastActivityAt) / 60000)} 分钟，去刷会儿贴吧`);
      const result = await this.onIdle();
      this.lastResult = { at: Date.now(), ...result };
      this.bus?.emit('idle', { action: 'done', reason, ...result });
      return result;
    } catch (error) {
      this.lastResult = { at: Date.now(), ok: false, reason: error.message };
      logger.error(`刷贴吧失败：${error.message}`);
      this.bus?.emit('idle', { action: 'error', reason, message: error.message });
      return { ok: false, reason: error.message };
    } finally {
      this.running = false;
      // 跑完从现在重新算安静时间，别刚跑完又跑
      this.lastActivityAt = Date.now();
    }
  }
}
