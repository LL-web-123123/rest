import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 每个群一份独立的近期上下文。
 * 落盘到 data/context/<groupId>.json，重启后按群恢复，不会串群。
 */
export class ContextStore {
  constructor({ dir, enabled = true, size = 1000, maxChars = 200000 }) {
    this.dir = dir;
    this.enabled = enabled;
    this.size = size;
    this.maxChars = maxChars;
    this.cache = new Map();
    this.saveTimers = new Map();
  }

  configure({ enabled, size }) {
    if (typeof enabled === 'boolean') this.enabled = enabled;
    if (Number.isFinite(size) && size > 0) this.size = size;
  }

  #file(groupId) {
    return path.join(this.dir, `${String(groupId).replace(/[^\w.-]/g, '_')}.json`);
  }

  async get(groupId) {
    if (!this.enabled) return [];
    if (this.cache.has(groupId)) return this.cache.get(groupId);
    const file = this.#file(groupId);
    let list = [];
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        if (Array.isArray(raw?.messages)) list = raw.messages;
      } catch {
        list = [];
      }
    }
    this.cache.set(groupId, list);
    return list;
  }

  async push(groupId, entry) {
    if (!this.enabled) return;
    const list = await this.get(groupId);
    list.push(entry);
    let chars = list.reduce((sum, item) => sum + (item?.t?.length ?? 0), 0);
    while (list.length > this.size || (chars > this.maxChars && list.length > 2)) {
      const removed = list.shift();
      chars -= removed?.t?.length ?? 0;
    }
    this.#scheduleSave(groupId);
  }

  async clear(groupId) {
    this.cache.set(groupId, []);
    this.#scheduleSave(groupId);
  }

  clearAll() {
    for (const groupId of this.cache.keys()) this.cache.set(groupId, []);
    for (const groupId of this.cache.keys()) this.#scheduleSave(groupId);
  }

  #scheduleSave(groupId) {
    const existing = this.saveTimers.get(groupId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.saveTimers.delete(groupId);
      void this.#save(groupId);
    }, 800);
    timer.unref?.();
    this.saveTimers.set(groupId, timer);
  }

  async #save(groupId) {
    const list = this.cache.get(groupId) ?? [];
    const file = this.#file(groupId);
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ groupId, messages: list }, null, 2), 'utf8');
      await rename(tmp, file);
    } catch {
      /* 上下文存不下不致命，内存里还在 */
    }
  }

  async flush() {
    for (const groupId of this.cache.keys()) await this.#save(groupId);
  }
}
