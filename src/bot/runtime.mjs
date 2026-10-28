import { createClient, configureLogger, segment } from 'douyin-im';
import { ACCOUNTS_DIR } from '../config.mjs';
import { createLogger } from '../logger.mjs';
import { hashText } from './rules.mjs';

const logger = createLogger('抖音');

/**
 * 抖音 IM 连接层：登录、二维码、群列表、发消息。
 * 业务逻辑全在 BotPipeline 里，这里只负责把 SDK 的事件翻译成界面能看懂的状态。
 */
export class BotRuntime {
  constructor({ getConfig, pipeline, bus, stickers }) {
    this.getConfig = getConfig;
    this.pipeline = pipeline;
    this.bus = bus;
    this.stickers = stickers;
    this.client = null;
    this.account = null;
    this.state = {
      login: 'idle', // idle | qrcode | verifying | online | error
      qr: '',
      uid: '',
      nickname: '',
      error: '',
      groups: [],
      connectedAt: 0,
      stickerCount: 0,
    };
    this.pendingSms = null;
  }

  #publish(patch = {}) {
    Object.assign(this.state, patch);
    this.bus.emit('state', this.publicState());
  }

  publicState() {
    return {
      login: this.state.login,
      qr: this.state.qr,
      uid: this.state.uid,
      nickname: this.state.nickname,
      error: this.state.error,
      groups: this.state.groups,
      connectedAt: this.state.connectedAt,
      stickerCount: this.state.stickerCount,
    };
  }

  async connect() {
    if (this.client) return;
    const config = this.getConfig();
    configureLogger({ level: config.bot.debug ? 'debug' : 'info', color: false, maskSensitive: true });
    this.#publish({ login: 'idle', error: '', qr: '' });

    const client = createClient({ dataDir: ACCOUNTS_DIR });
    this.client = client;

    client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
      this.account = account;
      this.pipeline.setAccountUid(account.imUid ?? account.uid ?? '');
      this.pipeline.setAccount?.(account);
      this.#publish({ login: 'qrcode', qr: `data:image/png;base64,${qrcodeBase64}`, error: '' });
      logger.info('需要扫码登录：二维码已显示在界面上');
      try {
        await account.continueLogin();
      } catch (error) {
        logger.error(`继续登录失败：${error.message}`);
      }
    });

    client.on('system.login.sms', ({ account }) => {
      this.#publish({ login: 'verifying', error: '' });
      logger.warn('抖音要求短信验证码，请在界面输入');
      const promise = new Promise((resolve) => { this.pendingSms = resolve; });
      promise.then((code) => account.continueLoginWithSms(code).catch((error) => {
        logger.error(`提交短信验证码失败：${error.message}`);
      }));
    });

    client.on('system.login.verification', async ({ account, verification }) => {
      this.#publish({ login: 'verifying', error: '' });
      const methods = verification.methods?.join(', ') ?? '滑块/短信/扫码';
      logger.warn(`抖音要求安全验证（${methods}），已打开本地验证页，请在浏览器里完成`);
      try {
        await verification.open();
        logger.info('安全验证已结束，继续登录');
      } catch (error) {
        logger.error(`安全验证失败：${error.message} —— 可稍后点「重新登录」`);
      }
      void account;
    });

    client.on('system.online', async ({ account }) => {
      this.account = account;
      this.pipeline.setAccountUid(account.imUid ?? account.uid ?? '');
      this.pipeline.setAccount?.(account);
      this.#publish({
        login: 'online',
        qr: '',
        uid: account.uid ?? '',
        nickname: account.nickname ?? '',
        error: '',
        connectedAt: Date.now(),
      });
      logger.info(`已上线：${account.nickname ?? ''}(${account.uid ?? ''})`);

      // 联系人仍可能还在加载，稍等一下再拉群列表，避免拿到空表。
      setTimeout(() => { void this.refreshGroups(); }, 2500);
      // 收藏表情同理，上线后拉一次存本地
      setTimeout(() => {
        void this.stickers?.refresh(account).then(() => {
          this.#publish({ stickerCount: this.stickers?.count ?? 0 });
        });
      }, 4000);
    });

    client.on('system.login.error', ({ error }) => {
      this.#publish({ login: 'error', error: error?.message ?? String(error), qr: '' });
      logger.error(`登录失败：${error?.message ?? error}`);
    });

    client.on('message.group', (event) => {
      void this.pipeline.handle(event).catch((error) => {
        logger.error(`处理群消息出错：${error?.stack ?? error}`);
      });
    });

    client.on('system.handler.error', ({ error, event }) => {
      logger.error(`事件处理失败 ${event ?? ''}：${error?.message ?? error}`);
    });

    logger.info('正在登录抖音（首次运行会生成二维码）…');
    try {
      await client.login();
    } catch (error) {
      this.#publish({ login: 'error', error: error?.message ?? String(error) });
      logger.error(`登录流程异常：${error?.message ?? error}`);
    }
  }

  async refreshGroups() {
    if (!this.client || !this.account) return [];
    try {
      const list = await this.account.getGroupList(true);
      const groups = list.map((group) => ({
        id: String(group.groupId),
        name: group.name || `群 ${String(group.groupId).slice(-6)}`,
        members: group.memberCount ?? 0,
        owner: group.ownerUid ?? '',
      }));
      this.#publish({ groups });
      this.pipeline.setGroupNames?.(groups);
      logger.info(`群列表已刷新：${groups.length} 个群`);
      return groups;
    } catch (error) {
      logger.error(`拉群列表失败：${error.message}`);
      return this.state.groups;
    }
  }

  async submitSmsCode(code) {
    if (!this.pendingSms) return false;
    const resolve = this.pendingSms;
    this.pendingSms = null;
    resolve(String(code).trim());
    return true;
  }

  /** 列一个群的成员，用来认人（比如把老大本人挑出来）。 */
  async listMembers(groupId, keyword = '') {
    if (!this.account) throw new Error('还没登录，先扫码');
    const target = String(groupId);
    let group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    if (!group) {
      await this.refreshGroups();
      group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    }
    if (!group) throw new Error(`找不到群 ${target}`);
    const map = await group.getMemberList();
    const list = [...map.values()].map((member) => ({
      uid: String(member.uid ?? ''),
      name: String(member.displayName ?? member.nickname ?? ''),
      nickname: String(member.nickname ?? ''),
      role: Number(member.role ?? 0),
    }));
    const needle = String(keyword ?? '').trim();
    return needle ? list.filter((item) => item.name.includes(needle) || item.uid.includes(needle)) : list;
  }

  /** 发一张图到群里。 */
  async sendImageTo(groupId, filePath) {
    if (!this.account) throw new Error('还没登录，先扫码');
    const { readFile } = await import('node:fs/promises');
    const { segment } = await import('douyin-im');
    const target = String(groupId);
    let group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    if (!group) {
      await this.refreshGroups();
      group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    }
    if (!group) throw new Error('找不到群 ' + target);
    const image = await readFile(filePath);
    const msg = segment.image(new Uint8Array(image));
    const response = await group.sendMsg(msg);
    if (response?.statusCode && response.statusCode !== 0) {
      throw new Error('发送被拒：' + (response.statusMsg ?? response.statusCode));
    }
    return response;
  }

  /** 发一段视频（音频也行：配个封面当视频发，抖音群没有语音气泡这种类型）。 */
  async sendVideoTo(groupId, filePath, coverPath) {
    if (!this.account) throw new Error('还没登录，先扫码');
    const { readFile } = await import('node:fs/promises');
    const { segment } = await import('douyin-im');
    const target = String(groupId);
    let group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    if (!group) {
      await this.refreshGroups();
      group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    }
    if (!group) throw new Error('找不到群 ' + target);
    const video = await readFile(filePath);
    const cover = coverPath ? await readFile(coverPath) : undefined;
    const msg = segment.video(new Uint8Array(video), cover ? new Uint8Array(cover) : new Uint8Array(video), { width: 720, height: 720 });
    const response = await group.sendMsg(msg);
    if (response?.statusCode && response.statusCode !== 0) throw new Error(response.statusMsg ?? '发送被拒');
    logger.info('发出视频 → ' + (group.name ?? target));
    return { ok: true };
  }

  /** 界面上的「手动发一句」，用来做端到端验证。 */
  async sendTo(groupId, text) {    void this.getConfig;
    if (!this.account) throw new Error('还没登录，先扫码');
    const target = String(groupId);
    let group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    if (!group) {
      await this.refreshGroups();
      group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    }
    if (!group) throw new Error(`找不到群 ${target}，先在群列表里刷新一次`);
    const response = await group.sendMsg(text);
    if (response?.statusCode && response.statusCode !== 0) {
      throw new Error(`${response.statusMsg ?? '发送被拒'}(${response.statusCode})`);
    }
    logger.info(`手动发出 → ${group.name ?? target}：${text}`);
    this.pipeline.sentEcho.set(hashText(text), Date.now());
    return response;
  }

  /** 手动发一个收藏表情，界面上的表情面板点一下就走这里。 */
  async sendStickerTo(groupId, stickerId) {
    if (!this.account) throw new Error('还没登录，先扫码');
    const item = this.stickers?.get(stickerId);
    if (!item) throw new Error(`找不到这个表情（${stickerId}）`);
    const target = String(groupId);
    let group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    if (!group) {
      await this.refreshGroups();
      group = this.account.pickGroup?.(target) ?? this.account.gl?.get(target);
    }
    if (!group) throw new Error(`找不到群 ${target}`);
    const response = await group.sendMsg(segment.sticker(item));
    if (response?.statusCode && response.statusCode !== 0) {
      throw new Error(`${response.statusMsg ?? '发送被拒'}(${response.statusCode})`);
    }
    logger.info(`手动发了个表情 → ${group.name ?? target}`);
    return response;
  }

  async disconnect() {
    if (!this.client) return;
    try {
      await this.client.logout();
      logger.info('已退出登录');
    } catch (error) {
      logger.warn(`退出登录时报错：${error.message}`);
    }
    this.client = null;
    this.account = null;
    this.pipeline.setAccountUid('');
    this.#publish({ login: 'idle', qr: '', uid: '', nickname: '', groups: [] });
  }
}
