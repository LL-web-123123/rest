import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 收藏表情包管理。
 * 账号里收藏的表情是唯一能「像表情一样」发出去的东西（segment.sticker），
 * 所以启动上线后拉一次，存本地，之后随机挑。
 */
export class StickerStore {
  constructor({ dir, logger }) {
    this.file = path.join(dir, 'stickers.json');
    this.logger = logger;
    this.items = [];
    this.recent = [];
    this.enabledStatus = undefined;
    this.lastError = '';
  }

  async load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.items)) this.items = raw.items;
      this.enabledStatus = raw?.enabledStatus;
      this.logger.info(`本地已有 ${this.items.length} 个收藏表情`);
    } catch (error) {
      this.logger.warn(`读取表情缓存失败：${error.message}`);
    }
  }

  async #save() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(
        this.file,
        JSON.stringify({ items: this.items, enabledStatus: this.enabledStatus, savedAt: Date.now() }, null, 2),
        'utf8',
      );
    } catch (error) {
      this.logger.warn(`保存表情缓存失败：${error.message}`);
    }
  }

  /** 分页拉一遍账号里收藏的表情。只读，不会改账号里的东西。 */
  async refresh(account) {
    if (!account?.getCollectedEmojis) return this.items;
    const collected = [];
    let cursor;
    let status;
    try {
      for (let page = 0; page < 5; page += 1) {
        const response = await account.getCollectedEmojis(cursor ? { cursor } : {});
        status = response;
        const stickers = response?.page?.stickers;
        if (Array.isArray(stickers)) collected.push(...stickers);
        if (response?.page?.stickerEnabledStatus !== undefined) {
          this.enabledStatus = response.page.stickerEnabledStatus;
        }
        const next = response?.page?.nextCursor;
        if (!response?.page?.hasMore || !next || next === cursor) break;
        cursor = next;
      }
    } catch (error) {
      this.lastError = error.message;
      this.logger.warn(`拉收藏表情失败：${error.message}`);
      return this.items;
    }

    if (collected.length) {
      this.items = collected;
      await this.#save();
      this.logger.info(`拉到 ${collected.length} 个收藏表情${this.enabledStatus === false ? '（收藏表情开关是关的，可能发不出去）' : ''}`);
    } else if (status?.statusCode && status.statusCode !== 0) {
      this.lastError = `${status.statusMsg ?? ''}(${status.statusCode})`;
      this.logger.warn(`账号里没有拿到收藏表情：${this.lastError}`);
    }
    return this.items;
  }

  list() {
    return this.items.map((item, index) => ({
      index,
      id: String(item?.['id'] ?? ''),
      name: String(item?.['display_name'] ?? item?.['name'] ?? '表情'),
      url: previewUrl(item),
      animated: Boolean(item?.['animate_url']?.['url_list']?.[0]),
    }));
  }

  get count() {
    return this.items.length;
  }

  /** 随机挑一个，尽量避开最近发过的几个。 */
  pick() {
    if (!this.items.length) return undefined;
    const fresh = this.items.filter((item) => !this.recent.includes(String(item?.['id'] ?? '')));
    const pool = fresh.length ? fresh : this.items;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const id = String(chosen?.['id'] ?? '');
    this.recent.push(id);
    while (this.recent.length > Math.min(8, Math.max(1, this.items.length - 1))) this.recent.shift();
    return chosen;
  }

  get(id) {
    return this.items.find((item) => String(item?.['id'] ?? '') === String(id));
  }
}

export function previewUrl(item) {
  const animate = item?.['animate_url']?.['url_list']?.[0];
  const still = item?.['static_url']?.['url_list']?.[0];
  return String(animate ?? still ?? '');
}
