import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.mjs';

const logger = createLogger('看视频');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 在 PATH 里手动找一个可执行文件，别只依赖 spawn 试错。 */
function onPath(name) {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter);
  const exts = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE').split(';')
    : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      if (existsSync(full)) return full;
    }
  }
  return '';
}

/** 按顺序找一个能用的 ffmpeg：配置里指定的 > PATH > 常见捆绑位置。 */
export function findFfmpeg(configured = '') {
  const candidates = [
    configured,
    onPath('ffmpeg'),
    'C:\\Users\\LL\\.dsh\\tools\\package\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === configured && configured) {
      if (existsSync(configured)) return configured;
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function run(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 从作品详情里挖出能下载的媒体地址，顺带把封面也捞出来。
 * 抖音的字段名在不同版本里换过，所以按优先级都试一遍，别只认一个。
 */
export function pickMediaUrls(detail) {
  const media = [];
  const covers = [];
  const pushUrl = (target, value) => {
    if (typeof value === 'string' && /^https?:\/\//.test(value) && !target.includes(value)) {
      target.push(value);
    }
  };
  const pushList = (target, node) => {
    const list = node?.url_list;
    if (Array.isArray(list)) for (const item of list) pushUrl(target, item);
  };

  const root = detail && typeof detail === 'object' ? detail : {};
  const video = root.video ?? {};
  for (const key of ['play_addr', 'play_addr_h264', 'play_addr_265', 'download_addr', 'play_addr_bytevc1']) {
    pushList(media, video[key]);
  }
  if (Array.isArray(video.bit_rate)) {
    for (const item of video.bit_rate) pushList(media, item?.play_addr);
  }
  // 图集：没有 video，只有一组图片
  if (Array.isArray(root.images)) {
    for (const image of root.images) pushList(media, image);
  }
  pushList(covers, root.cover);
  pushList(covers, root.origin_cover);
  pushList(covers, root.dynamic_cover);

  return { media, covers, title: String(root.desc ?? '') };
}

async function download(url, { maxBytes = 40 * 1024 * 1024, timeoutMs = 30000 } = {}) {  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length && length > maxBytes) throw new Error(`文件太大 ${(length / 1048576).toFixed(1)}MB`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`文件太大 ${(buffer.length / 1048576).toFixed(1)}MB`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDuration(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 20000 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** 在整条视频上均匀挑几个时间点，保证头尾都看得到。 */
export function frameTimestamps(duration, count = 4) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? 0.5 : 0.12 + (0.76 * i) / (count - 1);
    points.push(Math.min(Math.max(duration * ratio, 0.1), Math.max(duration - 0.2, 0.1)));
  }
  return points;
}

/** 群里发的图片：从 ImageResource 里挑能下的地址，原图优先。 */
export function pickImageUrls(image) {
  if (!image || typeof image !== 'object') return [];
  const order = ['originUrls', 'largeUrls', 'mediumUrls', 'thumbUrls'];
  const out = [];
  for (const key of order) {
    const list = image[key];
    if (Array.isArray(list)) {
      for (const url of list) {
        if (typeof url === 'string' && /^https?:\/\//.test(url) && !out.includes(url)) out.push(url);
      }
    }
  }
  return out;
}

/** 下一张图，返回 {base64, mime} 或 undefined。 */
export async function grabImage({ urls = [], maxBytes = 20971520 } = {}) {
  for (const url of urls.slice(0, 3)) {
    try {
      const buffer = await download(url, { maxBytes });
      if (buffer.length < 256) continue;
      const mime = sniffMime(buffer);
      if (!mime) continue;
      return { base64: buffer.toString('base64'), mime, bytes: buffer.length };
    } catch (error) {
      logger.warn(`图片下载失败：${error.message}`);
    }
  }
  return undefined;
}

function sniffMime(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buffer.length > 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

/**
 * 抓一帧一张图。返回 base64 数组。
 * 视频拿不到就退一步只要封面——但要如实告诉调用方「只看到封面」。
 */
export async function grabFrames({ ffmpeg, mediaUrls = [], coverUrls = [], count = 4, maxBytes }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dybot-frame-'));
  try {
    const frames = [];
    let note = '';

    for (const url of mediaUrls.slice(0, 3)) {
      let file;
      try {
        const buffer = await download(url, { maxBytes });
        if (buffer.length < 2048) throw new Error('下载到的是空文件');
        file = path.join(dir, 'video.mp4');
        await writeFile(file, buffer);
      } catch (error) {
        logger.warn(`视频下载失败：${error.message}`);
        continue;
      }

      const duration = await probeDuration(ffmpeg, file);
      const points = frameTimestamps(duration, count);
      for (let i = 0; i < points.length; i += 1) {
        const out = path.join(dir, `frame-${i}.jpg`);
        const result = await run(ffmpeg, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-ss', points[i].toFixed(2), '-i', file,
          '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', out,
        ], { timeoutMs: 30000 });
        if (result.code !== 0) continue;
        if (!existsSync(out)) continue;
        const data = await readFile(out);
        if (data.length < 512) continue;
        frames.push({ base64: data.toString('base64'), mime: 'image/jpeg' });
      }
      if (frames.length) {
        note = `视频${duration ? ` ${duration.toFixed(0)} 秒` : ''}，抽了 ${frames.length} 帧`;
        break;
      }
    }

    if (!frames.length) {
      for (const url of coverUrls.slice(0, 2)) {
        try {
          const buffer = await download(url, { maxBytes: 8 * 1024 * 1024 });
          if (buffer.length < 512) continue;
          frames.push({ base64: buffer.toString('base64'), mime: 'image/jpeg' });
          note = '只拿到了封面，视频没下下来';
          break;
        } catch (error) {
          logger.warn(`封面下载失败：${error.message}`);
        }
      }
    }

    const leftover = await readdir(dir).catch(() => []);
    void leftover;
    return { frames, note };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
