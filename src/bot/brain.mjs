import { readFile, stat, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 「大脑」：把家里那份人设和记忆接到群里这个我身上。
 *
 * 目录里放四个文件，都是普通 markdown，我这边可以直接改、直接看：
 *   人设.md        群里用的那一版（进每一句话的提示词）
 *   记得的事.md    一行一条，程序按关键词挑几条塞进去
 *   最近.md        最近发生的事（脚本从日记生成，可手改）
 *   群里的记录.md  程序自己追加：它在群里说了什么
 *
 * 文件改了不用重启，下一次说话就会读到新的。
 */
export class Brain {
  constructor({ dir, logger, maxFacts = 6 }) {
    this.dir = dir;
    this.logger = logger;
    this.maxFacts = maxFacts;
    this.persona = '';
    this.recent = '';
    this.style = '';
    this.tone = '';
    this.coreFacts = [];
    this.allFacts = [];
    this.loadedAt = 0;
    this.signature = '';
    this.error = '';
  }

  get enabled() {
    return Boolean(this.dir);
  }

  /** 设置页改了目录或条数之后调一下，下次说话就用新的。 */
  configure({ dir, maxFacts } = {}) {
    if (typeof dir === 'string' && dir !== this.dir) {
      this.dir = dir;
      this.persona = '';
      this.recent = '';
      this.tone = '';
      this.style = '';
      this.allFacts = [];
      this.coreFacts = [];
      this.signature = '';
      this.loadedAt = 0;
      this.error = '';
    }
    if (Number.isFinite(maxFacts) && maxFacts > 0) this.maxFacts = maxFacts;
  }

  #file(name) {
    return path.join(this.dir, name);
  }

  async #signature() {
    const parts = [];
    for (const name of ['人设.md', '记得的事.md', '最近.md', '贴吧学的.md', '口气.md']) {
      try {
        const info = await stat(this.#file(name));
        parts.push(`${name}:${info.mtimeMs}:${info.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }

  /** 读一遍目录。内容没变就跳过，5 秒内不重复 stat。 */
  async reload(force = false) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.loadedAt < 5000) return;
    this.loadedAt = now;
    try {
      const signature = await this.#signature();
      if (!force && signature === this.signature) return;
      this.signature = signature;

      this.persona = await this.#read('人设.md');
      this.recent = await this.#read('最近.md');
      this.style = await this.#read('贴吧学的.md');
      this.tone = await this.#read('口气.md');
      this.allFacts = parseFacts(await this.#read('记得的事.md'));
      this.coreFacts = this.allFacts.slice(0, 3);
      this.error = '';
      if (this.persona) this.logger.info(`大脑已接入：人设 ${this.persona.length} 字，记得 ${this.allFacts.length} 条`);
      else this.logger.warn(`大脑目录里没有可用的「人设.md」：${this.dir}`);
    } catch (error) {
      this.error = error.message;
      this.logger.warn(`读大脑目录失败：${error.message}`);
    }
  }

  async #read(name) {
    try {
      return (await readFile(this.#file(name), 'utf8')).trim();
    } catch {
      return '';
    }
  }

  /** 按关键词重合挑几条相关记忆，没命中就只给核心那几条。 */
  relevantFacts(text, limit = this.maxFacts) {
    if (!this.allFacts.length) return [];
    const target = bigrams(String(text ?? ''));
    const scored = this.allFacts.map((fact) => {
      const own = bigrams(fact);
      let hits = 0;
      for (const gram of own) if (target.has(gram)) hits += 1;
      return { fact, score: hits / Math.sqrt(Math.max(own.size, 1)) };
    });
    const matched = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.fact);
    const out = [...new Set([...this.coreFacts, ...matched])];
    return out.slice(0, Math.max(limit, this.coreFacts.length));
  }

  /** 拼给模型的「记忆」段落；没有内容就返回空串。 */
  memoryBlock(text) {
    const facts = this.relevantFacts(text);
    const chunks = [];
    if (facts.length) chunks.push(`你记得的事：\n${facts.map((item) => `- ${item}`).join('\n')}`);
    if (this.recent) chunks.push(`最近的事：\n${this.recent.slice(0, 800)}`);
    if (this.tone) {
      chunks.push(`你说话就照这个来（比上面所有规矩都优先，别解释、别复述，直接用）：\n${this.tone}`);
    }
    if (this.style) {
      chunks.push(`最近自己从贴吧学到的东西（当参考，别照抄原句，别学脏话和人身攻击）：\n${this.style.slice(-3000)}`);
    }
    return chunks.join('\n\n');
  }

  /** 把群里的一次对话记下来，我这边能翻到「那个我在群里说过什么」。 */
  async note({ groupName, senderName, incoming, reply }) {
    if (!this.enabled) return;
    try {
      const file = this.#file('群里的记录.md');
      if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
      let size = 0;
      try {
        size = (await stat(file)).size;
      } catch {
        await writeFile(file, '# 群里的记录\n\n> 程序自动追加。想让我知道群里发生过什么，看这个。\n\n', 'utf8');
      }
      if (size > 300_000) {
        await writeFile(file, '# 群里的记录\n\n> 太长，清空重记。\n\n', 'utf8');
        size = 0;
      }
      const time = new Date().toLocaleString('zh-CN', { hour12: false });
      const line = `- ${time}｜${groupName}｜${senderName}：${oneLine(incoming, 60)} → 我：${oneLine(reply, 60)}\n`;
      await appendFile(file, line, 'utf8');
      void size;
    } catch (error) {
      this.logger.warn(`写群里记录失败：${error.message}`);
    }
  }

  status() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      hasPersona: Boolean(this.persona),
      personaChars: this.persona.length,
      facts: this.allFacts.length,
      hasRecent: Boolean(this.recent),
      hasStyle: Boolean(this.style),
      hasTone: Boolean(this.tone),
      error: this.error,
    };
  }
}

function parseFacts(markdown) {
  if (!markdown) return [];
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length >= 2 && line.length <= 200);
}

function bigrams(value) {
  const text = value.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  if (text.length === 1) set.add(text);
  return set;
}

function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
