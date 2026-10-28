import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 一个进程内总线：日志、群消息、发出的回复、状态变化都从这里走。
 * Web 界面用 SSE 订阅它，所以界面永远是实时的，不用轮询。
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

let minLevel = LEVELS.info;
let stream = null;
let streamDay = '';

function dayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ensureStream() {
  const day = dayKey();
  if (stream && day === streamDay) return stream;
  if (stream) stream.end();
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    stream = createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
    streamDay = day;
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
  return stream;
}

const tail = [];
const TAIL_SIZE = 400;

export function setLogLevel(level) {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, scope, message) {
  if ((LEVELS[level] ?? 20) < minLevel) return;
  const entry = { ts: Date.now(), time: stamp(), level, scope, message: String(message) };
  tail.push(entry);
  if (tail.length > TAIL_SIZE) tail.shift();
  bus.emit('log', entry);
  const line = `[${entry.time}] [${level.toUpperCase()}] [${scope}] ${entry.message}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
  try {
    ensureStream()?.write(line);
  } catch {
    /* 写不了文件不影响运行 */
  }
}

export function createLogger(scope) {
  return {
    debug: (msg) => emit('debug', scope, msg),
    info: (msg) => emit('info', scope, msg),
    warn: (msg) => emit('warn', scope, msg),
    error: (msg) => emit('error', scope, msg),
  };
}

export function recentLogs(limit = 200) {
  return tail.slice(-limit);
}

export const log = createLogger('主程序');
