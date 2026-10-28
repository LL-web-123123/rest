/**
 * 把人味插件里的热梗库（data/memes.json，1000 条）过滤成一份能用的，落到 dybot/data/memes.json。
 *
 * 为什么要过滤：
 *   一千条里一大半是从 B 站「热梗盘点」标题里扒出来的，只有名字没有解释，
 *   直接塞给模型，它只会照着名字瞎用。这里只留「有解释」的，再按语料出现次数排序。
 *
 * 用法：
 *   node scripts/sync-memes.mjs                       # 用默认路径（本机的人味插件）
 *   node scripts/sync-memes.mjs <源 memes.json 路径>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'memes.json');
const DEFAULT_SRC = 'C:\\Users\\LL\\.dsh\\plugin-src\\dsh-fish-tone-flavor\\data\\memes.json';

/** 这些词不进群：骂人、拿家里人开涮、以及直播间/群里容易惹事的。 */
const BLOCKED = [
  '妈的', '尼玛', '你妈', '死妈', '草泥马', '傻逼', '煞笔', '智障', 'nmsl',
  '屁眼', '屌', '逼', '乳华', '台独', '港独', '支那',
];

function clean(entry) {
  const term = String(entry.term ?? '').trim();
  const gloss = String(entry.gloss ?? '').trim();
  if (!term || term.length > 20) return null;
  if (gloss.length < 4) return null;
  const hay = `${term}${gloss}${entry.usage ?? ''}`.toLowerCase();
  if (BLOCKED.some((word) => hay.includes(word))) return null;
  const hits = Number(entry.corpus?.hits ?? 0);
  // 没在语料里出现过的，八成是盘点标题里带出来的生词，不留
  if (!entry.known && hits < 5) return null;
  return {
    term,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String).filter(Boolean).slice(0, 3) : [],
    year: String(entry.year ?? ''),
    vibes: Array.isArray(entry.vibes) ? entry.vibes.map(String).slice(0, 3) : [],
    gloss,
    usage: String(entry.usage ?? '').trim(),
    hits,
    known: Boolean(entry.known),
  };
}

const src = process.argv[2] || DEFAULT_SRC;
const raw = JSON.parse(await readFile(src, 'utf8'));
const source = Array.isArray(raw) ? raw : raw.memes ?? [];
const kept = source.map(clean).filter(Boolean).sort((a, b) => b.hits - a.hits);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    note: '由 scripts/sync-memes.mjs 从人味插件（dsh-fish-tone-flavor）的热梗库过滤生成。别手改，改源头再跑一次。',
    builtAt: new Date().toISOString(),
    sourceFile: src,
    sourceCount: source.length,
    count: kept.length,
    memes: kept,
  }, null, 2),
  'utf8',
);

console.log(`源 ${source.length} 条 → 留下 ${kept.length} 条，写到 ${OUT}`);
console.log('前五条：' + kept.slice(0, 5).map((m) => `${m.term}(${m.hits})`).join(' '));
