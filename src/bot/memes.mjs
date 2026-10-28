import { readFile, stat } from 'node:fs/promises';

/**
 * 热梗库：从人味插件那份梗库里挑几条塞进群里的提示词。
 *
 * 两个来源一起用：
 *   1) 跟最新这条消息沾边的（按二元组重合挑）——有人提「典」，就给它「典」「太典了」这几条
 *   2) 每天轮换的几条大众梗——保证不会永远只有那几个老梗
 *
 * 用法：
 *   const memes = new MemeBook({ file, logger });
 *   memes.block('这也太典了吧')  → 一段 markdown，直接拼进 system 提示词
 */
export class MemeBook {
  constructor({ file, logger, limit = 4 } = {}) {
    this.file = file;
    this.logger = logger;
    this.limit = limit;
    this.items = [];
    this.loadedAt = 0;
    this.signature = '';
    this.error = '';
    this.ready = false;
  }

  async load(force = false) {
    if (!this.file) return;
    try {
      const info = await stat(this.file);
      const signature = `${info.mtimeMs}:${info.size}`;
      if (!force && this.ready && signature === this.signature) return;
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.memes ?? [];
      this.items = list
        .filter((item) => item && item.term && String(item.gloss ?? '').length >= 4)
        .map((item) => ({
          term: String(item.term),
          aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
          vibes: Array.isArray(item.vibes) ? item.vibes.map(String) : [],
          gloss: String(item.gloss),
          usage: String(item.usage ?? ''),
          hits: Number(item.hits ?? 0),
        }))
        .sort((a, b) => b.hits - a.hits);
      this.signature = signature;
      this.ready = true;
      this.error = '';
      this.logger?.info?.(`梗库接上了：${this.items.length} 条`);
    } catch (error) {
      this.error = error.message;
      this.logger?.warn?.(`读梗库失败：${error.message}`);
    }
  }

  /** 跟这段文字沾边的梗，越多越靠前。 */
  relevant(text, limit = this.limit) {
    const source = String(text ?? '').toLowerCase();
    const target = bigrams(source);
    if (!target.size) return [];
    const scored = [];
    for (const item of this.items) {
      // 名字本身就在话里，那是真的在玩这个梗，直接算命中
      const named = [item.term, ...item.aliases].some((name) => name && source.includes(name.toLowerCase()));
      const own = bigrams([item.term, ...item.aliases, item.usage].join(' '));
      let hits = 0;
      for (const gram of own) if (target.has(gram)) hits += 1;
      if (!hits && !named) continue;
      // 光沾一个字不算，免得「开会」把「班味」翻出来
      if (!named && hits < 2) continue;
      const heat = 1 + Math.log10(item.hits + 1) / 8;
      const score = named ? 2 : (hits / Math.sqrt(Math.max(own.size, 1))) * heat;
      if (score < 0.25) continue;
      scored.push({ item, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  /** 大众梗，按天轮换，同一天里稳定。 */
  hot(limit = 2, day = null) {
    const pool = this.items.slice(0, 120);
    if (!pool.length) return [];
    const stamp = day ?? dayNumber();
    const out = [];
    for (let i = 0; i < limit && i < pool.length; i += 1) {
      const index = (stamp * 7 + i * 17) % pool.length;
      const item = pool[index];
      if (item && !out.includes(item)) out.push(item);
    }
    return out;
  }

  /**
   * 拼给模型的梗段落。挑不出来就返回空串——宁可没有，别硬凑。
   * @param {string} text 最新一条消息
   */
  block(text, { limit = this.limit, hotLimit = 2 } = {}) {
    if (!this.items.length) return '';
    const picked = [];
    for (const item of [...this.relevant(text, limit), ...this.hot(hotLimit)]) {
      if (item && !picked.includes(item)) picked.push(item);
      if (picked.length >= limit) break;
    }
    if (!picked.length) return '';
    const lines = picked.map(describe);
    return [
      '说到梗的时候，下面这些可以用（不是让你照抄，也不许每条都挂）：',
      ...lines,
      '规矩：一条回复最多一个梗，挂在句尾；意思拿不准、场合不对（有人认真问事、有人难受）就别挂，干着说更好。',
      '不许自己造梗，也不许把梗的解释念出来。',
    ].join('\n');
  }

  stats() {
    return {
      ready: this.ready,
      count: this.items.length,
      file: this.file ?? '',
      error: this.error,
      sample: this.hot(3).map((item) => item.term),
    };
  }
}

const VIBE_LABEL = {
  cute: '卖萌', abstract: '抽象', ironic: '阴阳', broken: '破防',
  work: '职场', heal: '治愈', hype: '燃', retro: '老梗',
  slacker: '摆烂', fun: '逗乐',
};

function describe(item) {
  const vibe = (item.vibes ?? []).map((name) => VIBE_LABEL[name] ?? name).slice(0, 2).join('/');
  const head = vibe ? `${item.term}（${vibe}）` : item.term;
  const parts = [`${head}：${item.gloss}`];
  if (item.usage && item.usage.length <= 24) parts.push(`像这样用：${item.usage}`);
  return `- ${parts.join('｜')}`;
}

function dayNumber() {
  return Math.floor(Date.now() / 86_400_000);
}

function bigrams(value) {
  const text = String(value ?? '').replace(/\s+/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  if (text.length === 1) set.add(text);
  return set;
}
