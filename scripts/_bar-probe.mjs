import { parseThreadList, parsePosts, keepLearnable } from '../src/idle/tieba.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

for (const kw of ['孙笑川', '孙吧', '孙笑川吧']) {
  try {
    const res = await fetch(`https://tieba.baidu.com/mo/q/m?kw=${encodeURIComponent(kw)}&pn=0`, { headers: { 'User-Agent': UA } });
    const html = await res.text();
    const list = parseThreadList(html);
    console.log(`${kw}: HTTP ${res.status} len=${html.length} 帖子=${list.length}`);
    if (list.length) console.log('    ', list.slice(0, 3).map((t) => t.title.slice(0, 30)).join(' / '));
  } catch (error) {
    console.log(kw, '失败', error.message);
  }
}

// 看看孙吧正文有多野，筛完还剩多少
const res = await fetch('https://tieba.baidu.com/mo/q/m?kw=%E5%AD%99%E7%AC%91%E5%B7%9D&pn=0', { headers: { 'User-Agent': UA } });
const list = parseThreadList(await res.text());
if (list.length) {
  const tid = list.find((t) => !/^置顶/.test(t.title))?.tid ?? list[0].tid;
  const page = await (await fetch(`https://tieba.baidu.com/mo/q/m?kz=${tid}`, { headers: { 'User-Agent': UA } })).text();
  const posts = parsePosts(page, { max: 20 });
  const kept = posts.filter(keepLearnable);
  console.log(`\n样本帖 ${tid}: 楼层 ${posts.length} 条，筛完剩 ${kept.length} 条`);
  console.log(kept.slice(0, 5).map((t) => `  · ${t.slice(0, 60)}`).join('\n'));
}
