// 梗百科：6668 条本地词库（来自 astrbot_plugin_memewiki 的 memes.db，已导成 JSON）
// 只在「像在问梗」的时候查，查到就把用法塞进提示词，让模型先接梗、再解释。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'memewiki.json';

export class MemeWiki {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger;
    this.items = null;
    this.byName = new Map();
    this.loadedAt = 0;
  }

  async load() {
    if (this.items) return this.items;
    try {
      const raw = await readFile(path.join(this.dir, FILE), 'utf8');
      const list = JSON.parse(raw);
      this.items = list;
      for (const item of list) {
        const key = String(item.name ?? '').trim();
        if (key) this.byName.set(key, item);
      }
      this.logger.info(`梗百科接上了：${list.length} 条`);
    } catch (error) {
      this.items = [];
      this.logger.warn(`梗百科没读到：${error.message}`);
    }
    return this.items;
  }

  /** 消息里出现书名号/引号包着的词，或整句像「XX 是什么梗」时，猜出要查的词。 */
  static pickTerm(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    const quoted = value.match(/[「『“"'【]([^」』”"'】]{2,12})[」』”"'】]/);
    if (quoted) return quoted[1];
    const ask = value.match(/^(.{2,12}?)(?:是什么梗|是啥梗|什么梗|啥意思|什么意思|啥梗)/);
    if (ask) return ask[1].replace(/^(请问|问一下|有人知道)/, '').trim();
    // 短词单独一条，也当成在问梗
    const bare = value.replace(/[\s，。、！？!?~～…]+/g, '');
    if (bare.length >= 2 && bare.length <= 8 && !/[?？]/.test(value)) return bare;
    return null;
  }

  /** 随手抽一条，用来自个儿抛梗。 */
  async random() {
    await this.load();
    if (!this.items.length) return null;
    const pool = this.items.filter((x) => (x.summary || x.usage || '').length > 20);
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  /** 返回提示词里那段话；查不到就空串。 */
  async block(text, { limit = 1 } = {}) {
    await this.load();
    if (!this.byName.size) return '';
    const term = MemeWiki.pickTerm(text);
    if (!term) return '';
    const hit = this.byName.get(term)
      ?? [...this.byName.values()].find((item) => String(item.name).includes(term));
    if (!hit) return '';
    const parts = [`「${hit.name}」这个梗：${(hit.summary || hit.origin || '').slice(0, 200)}`];
    if (hit.usage) parts.push(`怎么用：${hit.usage.slice(0, 600)}`);
    if (hit.origin) parts.push(`来历：${hit.origin.slice(0, 300)}`);
    parts.push('先照着用法接一句，再解释；一句就够，别背百科。');
    return `你查到的梗（本地词库，直接可用）：\n${parts.slice(0, limit + 3).join('\n')}`;
  }
}
