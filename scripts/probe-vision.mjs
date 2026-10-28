import { readFile } from "node:fs/promises";
import { grabFrames, findFfmpeg } from "../src/bot/video.mjs";
import { DeepSeekClient } from "../src/llm/deepseek.mjs";

const cfg = JSON.parse(await readFile("data/config.json", "utf8"));
const ffmpeg = findFfmpeg(cfg.media?.ffmpegPath ?? "");
console.log("ffmpeg:", ffmpeg);

const { frames, note } = await grabFrames({
  ffmpeg,
  mediaUrls: ["http://127.0.0.1:8891/test.mp4"],
  coverUrls: [],
  count: 4,
  maxBytes: 41943040,
});
console.log("frames:", frames.length, "note:", note);
if (!frames.length) process.exit(1);

const client = new DeepSeekClient(() => cfg.deepseek);
const raw = await client.completeVision(
  "你在一个群里，有人分享了视频，你看了几张截图。用一句话说你在图里看到什么，不超过40字。",
  "这是视频里的几帧，按时间顺序。",
  frames,
);
console.log("RAW >>>", JSON.stringify(raw));
console.log("LEN:", raw.length);
console.log("tokens:", JSON.stringify(client.stats));

