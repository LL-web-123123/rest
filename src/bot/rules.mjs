/** 纯函数堆在这里，方便单测。没有网络、没有状态。 */

const QUESTION_WORDS = [
  '吗', '呢', '？', '?', '怎么', '为什么', '为啥', '什么', '啥', '谁', '哪里', '哪儿',
  '哪个', '哪种', '哪款', '哪家', '咋', '多久', '几次', '几个', '啥时候', '什么时候',
  '多少', '几点', '是不是', '能不能', '可不可以', '要不要', '有没有', '行不行',
  '干嘛', '干啥', '做什么', '什么样',
  '有人知道', '求问', '请问', '怎么办', '如何', '对不对', '好不好', '真的假的',
];

const NOISE_PATTERNS = [
  /^[\s\p{P}\p{S}]*$/u, // 纯标点/表情符号
  /^(哈|呵|嘿|嘻|嗯|哦|噢|额|呃|啊|呀|哇)+$/u,
  /^\[[^\]]{1,10}\]$/, // [图片] [表情] 之类
  /^(https?:\/\/|www\.)\S+$/i,
  /^\d{1,6}$/,
];

export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeQuestion(text) {
  const value = normalizeText(text);
  if (value.length < 3 || value.length > 200) return false;
  return QUESTION_WORDS.some((word) => value.includes(word));
}

export function isNoise(text) {
  const value = normalizeText(text);
  if (!value) return true;
  if (value.length <= 1) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

export function topicHit(text, topics) {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  return String(topics ?? '')
    .split(/[,，\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((topic) => value.includes(topic));
}

/** 简单稳定哈希，用来给「刚发出去的话」做回显识别。 */
export function hashText(text) {
  let hash = 5381;
  const value = normalizeText(text);
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return `${value.length}:${hash >>> 0}`;
}

/**
 * 把模型输出洗成一条能直接发进群的消息：
 * 去掉自己加的名字前缀、包裹引号、换行和 markdown 记号，再截断。
 */
export function sanitizeReply(raw, { name = '', maxChars = 60 } = {}) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  value = value.replace(/^```[\s\S]*?\n|```$/g, '').trim();
  if (name) {
    const prefix = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]\\s*`, 'i');
    value = value.replace(prefix, '');
  }
  value = value.replace(/^\s*(我|小鱼|机器人|助手)\s*[:：]\s*/, '');
  // 群里回话不该以 @某人 开头，模型偶尔会自己加。中文名后面常常没空格，
  // 所以：14 字以内遇到分隔符就当成「@名字」整段砍掉，否则只砍掉那个 @。
  if (value.startsWith('@')) {
    const cut = value.search(/[\s，,。.、!！?？:：]/);
    let stripped;
    if (cut >= 0 && cut <= 14) stripped = value.slice(cut + 1);
    else stripped = value.slice(1);
    if (stripped.trim()) value = stripped.trim();
  }
  if (/^["'「『（(].*["'」』）)]$/s.test(value) && value.length > 2) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\*\*/g, '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ');
  value = value.replace(/^[-,，。、\s]+/, '');
  if (value.length > maxChars) {
    const clipped = value.slice(0, maxChars);
    const cut = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('，'), clipped.lastIndexOf(' '));
    value = cut >= maxChars * 0.6 ? clipped.slice(0, cut) : clipped;
    value = `${value.replace(/[，。、\s]+$/, '')}…`;
  }
  return value.trim();
}

/** 模型决定不接话时返回这个标记。 */
export const PASS_TOKEN = '[PASS]';

/** 模型想发表情包、不想说话时返回这个标记。 */
export const STICKER_TOKEN = '[STICKER]';

export function isStickerRequest(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  return value === STICKER_TOKEN || value === 'STICKER' || value.startsWith('[STICKER]');
}

/** 模型想上网查的时候会输出 [SEARCH] 查询词，这里把查询词抠出来。 */
export const SEARCH_TOKEN = '[SEARCH]';

export function parseSearchRequest(raw) {
  const text = String(raw ?? '').trim();
  const match = /^\[SEARCH\]\s*[:：]?\s*(.{1,120})$/is.exec(text);
  if (!match) return '';
  return match[1].replace(/^["'「《]|["'」》]$/g, '').trim();
}

/**
 * 抖音有些消息（红包、表情、分享卡片）正文是一大串 JSON。
 * 直接塞进上下文既难看又烧 token，所以先认出来，换成人看得懂的占位。
 */
export function describePayload(text, kind = 'text') {
  const value = normalizeText(text);
  if (kind !== 'text') return value;
  if (value.length > 40 && value.startsWith('{')) {
    if (/"redpacket/.test(value)) return '[红包]';
    if (/"emoji_|"aweType"\s*:\s*501/.test(value)) return '[表情]';
    if (/"aweme_im"|"cover_url"/.test(value)) return '[分享卡片]';
    return '[卡片消息]';
  }
  return value;
}

export function isPass(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  return value === PASS_TOKEN || value === 'PASS' || value.startsWith('[PASS]');
}
