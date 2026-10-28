import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.mjs';

const logger = createLogger('学说话');

export const STYLE_FILE = '贴吧学的.md';

const SYSTEM = [
  '你是一个语言观察员。下面是一堆百度贴吧里的真实回帖。',
  '你的任务不是评论他们，是从里面提炼「这里的人是怎么说话的」。',
  '',
  '请输出一小段中文笔记，分四块，每块两三行，不要长：',
  '1) 口头禅和高频词：他们反复用的词、语气词、缩写（写成词表）',
  '2) 句式：句子长短、怎么起头、怎么接话、怎么怼人、怎么自嘲',
  '3) 标点习惯：用不用句号、逗号多不多、爱不爱用省略号和括号',
  '4) 我能借用什么：挑 2 到 3 条适合我（一个抖音群里的聊天搭子）用的，说清楚怎么用',
  '',
  '规矩：',
  '- 只写观察到的，别编。样本不够就直说样本不够。',
  '- 这里本来就是一群嘴很脏、爱开地图炮的人。不要装作没有，也不要替他们美化。',
  '  地域黑、性别攻击、拿人长相和出身当笑点——这些可以当成「现象」记一句，',
  '  比如「拿省份当笑点是常见梗，谁都能被顺手编排一句」。',
  '  但不要抄成可以照着用的词表，不要写「你可以这么说」。观察是观察，配方是配方。',
  '- 骂人家人的那种脏话（问候父母、咒死全家），一句都不要出现，连举例都不要。',
  '- 广告话术、引流、联系方式，不要。',
  '- 不要写成论文，不要一二三四列得很整齐，像便签。',
  '- 笔记是给一个脾气冲但绝不刻薄的人看的：她可以懂那些刻薄，但不该照着说。',
].join('\n');

/**
 * 笔记落盘前只抹最狠那一档：问候父母、咒家里人、性侮辱。
 * 一般骂人的词（傻、弱智、废物这类）不抹——那是孙吧的日常用语，
 * 装作看不见就学不到东西了。真正要守的不是这里，是它别拿去说群里的人。
 */
const PROFANITY = [
  /操你[妈马]?/g, /草[你泥][马妈]?/g, /曹尼玛/g, /你妈[的死]/g, /尼玛/g,
  /死全家|全家[死暴]/g, /[滚爬]你[妈马]/g,
  /婊子|骚货|贱货/g,
];

export function sanitizeNote(text) {
  let out = String(text ?? '');
  for (const re of PROFANITY) out = out.replace(re, '…');
  return out.replace(/…{2,}/g, '…').trim();
}

/**
 * 让模型读一遍语料，写成一小段「学到的说话方式」，追加到大脑目录里。
 * 文件有上限，太长了就把旧的压一压，只留最近几次。
 */
export async function learnStyle({ deepseek, corpus, brainDir, kw, maxChars = 6000 }) {
  if (!Array.isArray(corpus) || corpus.length < 6) {
    logger.warn(`语料太少（${corpus?.length ?? 0} 条），这次不学`);
    return { ok: false, reason: 'corpus-too-small' };
  }
  const sample = corpus.slice(0, 120).map((text, index) => `${index + 1}. ${text}`).join('\n');
  let note;
  try {
    note = await deepseek.complete(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `下面是 ${corpus.length} 条贴吧回帖：\n\n${sample}` },
      ],
      { thinking: false, maxTokens: 1500 },
    );
  } catch (error) {
    logger.error(`学说话时模型出错：${error.message}`);
    return { ok: false, reason: error.message };
  }

  const cleaned = sanitizeNote(note);
  if (cleaned.length < 40) {
    logger.warn('模型给的东西太短，这次不记');
    return { ok: false, reason: 'too-short' };
  }

  if (!brainDir) {
    logger.warn('没配大脑目录，学到的没地方存');
    return { ok: false, reason: 'no-brain-dir' };
  }
  await mkdir(brainDir, { recursive: true }).catch(() => {});
  const file = path.join(brainDir, STYLE_FILE);

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const block = `\n## ${stamp}｜${kw}吧｜样本 ${corpus.length} 条\n\n${cleaned}\n`;
  let existing = '';
  if (existsSync(file)) {
    existing = await readFile(file, 'utf8');
  } else {
    existing = [
      '# 贴吧上学到的说话方式',
      '',
      '> 没人理我的时候，我自己去刷贴吧，把那边的人怎么说话记下来。',
      '> 这份会进提示词，所以只记「能用得上」的，不记脏话和人身攻击。',
      '> 这是我自己学的东西，老大可以随时删。',
      '',
    ].join('\n');
  }

  const merged = `${existing}${block}`;
  // 只留最近几段，别让它无限长
  const trimmed = merged.length > maxChars
    ? `${merged.slice(0, 400)}\n\n…（前面太长了，砍掉一些）\n\n${merged.slice(merged.length - (maxChars - 400))}`
    : merged;
  await writeFile(file, trimmed, 'utf8');
  logger.info(`学完一段，记进 ${STYLE_FILE}（${cleaned.length} 字）`);
  return { ok: true, chars: cleaned.length, file };
}
