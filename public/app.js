const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  runtime: null,
  bot: null,
  settingsFilled: false,
  logs: [],
  messages: [],
  replies: [],
};

const STATUS_LABEL = {
  idle: '未登录',
  qrcode: '等待扫码',
  verifying: '需要安全验证',
  online: '已上线',
  error: '登录出错',
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({ ok: false, error: '返回不是 JSON' }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- 渲染 ---------- */

function renderStatus() {
  const rt = state.runtime;
  if (!rt) return;
  const dot = $('statusDot');
  dot.className = 'dot';
  if (rt.login === 'online') dot.classList.add('online');
  else if (rt.login === 'qrcode' || rt.login === 'verifying') dot.classList.add('qr');
  else if (rt.login === 'error') dot.classList.add('error');

  let text = STATUS_LABEL[rt.login] || rt.login;
  if (rt.login === 'online' && rt.nickname) text = `已上线 · ${rt.nickname}`;
  $('statusText').textContent = text;

  const pill = $('accountPill');
  if (rt.login === 'online') {
    pill.textContent = `${rt.nickname || '已登录'}（${rt.uid || '?'}）`;
    pill.style.color = 'var(--ok)';
  } else {
    pill.textContent = STATUS_LABEL[rt.login] || '未登录';
    pill.style.color = 'var(--muted)';
  }

  const needLogin = rt.login === 'qrcode' || rt.login === 'verifying';
  $('loginCard').hidden = !needLogin && !(rt.login === 'error' && rt.error);
  if (rt.qr) $('qrImg').src = rt.qr;
  $('smsRow').hidden = rt.login !== 'verifying';
  $('loginError').textContent = rt.error || '';

  const enabled = Boolean(state.config?.bot?.enabled);
  $('btnToggle').textContent = enabled ? '停止监听' : '开始监听';
  $('btnToggle').dataset.enabled = enabled ? '1' : '0';
}

function renderStats() {
  const bot = state.bot;
  if (!bot) return;
  const enabled = Boolean(state.config?.bot?.enabled);
  $('statListen').textContent = enabled ? '已开启' : '已暂停';
  $('statListen').style.color = enabled ? 'var(--ok)' : 'var(--warn)';
  $('statGroups').textContent = state.runtime?.groups?.length ?? 0;
  $('statReceived').textContent = bot.counters.received;
  $('statReplied').textContent = bot.counters.replied;
  $('statHour').textContent = bot.repliesLastHour;
  $('statFailed').textContent = bot.counters.failed;
}

function renderGroups() {
  const groups = state.runtime?.groups ?? [];
  const whitelist = state.config?.bot?.groupWhitelist ?? [];
  const box = $('groupList');
  box.innerHTML = '';
  if (!groups.length) {
    box.innerHTML = '<li class="muted">还没有群。登录后点「刷新群列表」。</li>';
  }
  for (const group of groups) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = whitelist.includes(group.id);
    cb.addEventListener('change', () => toggleWhitelist(group.id, cb.checked));
    const name = document.createElement('span');
    name.textContent = group.name;
    const gid = document.createElement('span');
    gid.className = 'gid';
    gid.textContent = `${group.id}${group.members ? ` · ${group.members}人` : ''}`;
    label.append(cb, name, gid);
    li.append(label);
    box.append(li);
  }
  $('groupHint').textContent = whitelist.length
    ? `已选 ${whitelist.length} 个群，只在这些群里回复`
    : '一个群都没勾：现在不会在任何群回复';

  const select = $('manualGroup');
  const current = select.value;
  select.innerHTML = '';
  const stickerSelect = $('stickerGroup');
  const currentSticker = stickerSelect.value;
  stickerSelect.innerHTML = '';
  for (const group of groups) {
    const opt = document.createElement('option');
    opt.value = group.id;
    opt.textContent = group.name;
    select.append(opt);
    stickerSelect.append(opt.cloneNode(true));
  }
  if (current) select.value = current;
  if (currentSticker) stickerSelect.value = currentSticker;
}

async function toggleWhitelist(groupId, checked) {
  const list = new Set(state.config?.bot?.groupWhitelist ?? []);
  if (checked) list.add(groupId);
  else list.delete(groupId);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ bot: { groupWhitelist: [...list] } }),
    });
    state.config = data.config;
    renderGroups();
    renderStats();
  } catch (error) {
    alert(`保存白名单失败：${error.message}`);
  }
}

function entryLine(item, kind) {
  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(item.ts);
  if (kind === 'message') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = item.senderName + (item.mentioned ? '（@我）' : '');
    const grp = document.createElement('span');
    grp.className = 'grp';
    grp.textContent = ` @${item.groupName}`;
    const body = document.createTextNode(item.text);
    li.append(time, who, grp, document.createElement('br'), body);
  } else {
    const grp = document.createElement('span');
    grp.className = 'grp';
    grp.textContent = `→ ${item.groupName} (${item.reasons})`;
    const body = document.createTextNode(item.text);
    li.append(time, grp, document.createElement('br'), body);
  }
  return li;
}

function renderFeed(which) {
  const box = which === 'message' ? $('msgFeed') : $('replyFeed');
  const list = which === 'message' ? state.messages : state.replies;
  box.innerHTML = '';
  for (const item of list.slice(-25).reverse()) box.append(entryLine(item, which));
}

function renderLogs() {
  const box = $('logBox');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = '';
  for (const entry of state.logs.slice(-300)) {
    const span = document.createElement('span');
    span.className = entry.level;
    span.textContent = `[${entry.time.slice(11)}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}\n`;
    box.append(span);
  }
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------- 设置表单 ---------- */

function fillSettings() {
  const cfg = state.config;
  if (!cfg || state.settingsFilled) return;
  state.settingsFilled = true;
  const d = cfg.deepseek;
  const b = cfg.bot;

  $('cfgApiKey').placeholder = d.apiKeySet
    ? `已保存（尾号 ${d.apiKeyTail}），留空表示不修改`
    : 'sk-… 粘贴你的 DeepSeek Key';
  $('cfgModel').value = d.model;
  $('cfgTemp').value = d.temperature;
  $('cfgMaxTokens').value = d.maxTokens;
  $('cfgTimeout').value = d.timeoutMs;
  $('cfgRetries').value = d.retries;
  $('cfgThinking').checked = Boolean(d.thinking);

  $('cfgName').value = b.name;
  $('cfgPersona').value = b.persona;
  $('cfgStyle').value = b.style;
  $('cfgTopics').value = b.topics;
  $('cfgOwnerUids').value = (b.ownerUids ?? []).join(', ');
  $('cfgMode').value = b.replyMode;
  $('cfgProb').value = b.activeProbability;
  $('cfgGroupCd').value = b.groupCooldownSec;
  $('cfgReplyCd').value = b.replyCooldownSec;
  $('cfgMaxHour').value = b.maxRepliesPerHour;
  $('cfgMaxChars').value = b.maxChars;
  $('cfgCtxSize').value = b.contextSize;
  $('cfgWatchVideos').checked = b.watchVideos !== false;
  $('cfgMaxWatches').value = b.maxVideoWatchesPerHour ?? 6;
  $('cfgWatchImages').checked = b.watchImages !== false;
  $('cfgMaxImageLooks').value = b.maxImageLooksPerHour ?? 10;
  $('cfgSendStickers').checked = b.sendStickers !== false;
  $('cfgUseMemes').checked = b.useMemes !== false;
  $('cfgMemeLimit').value = b.memeLimit ?? 4;
  $('cfgWebSearch').checked = b.webSearch !== false;
  $('cfgMaxSearch').value = b.maxSearchesPerHour ?? 8;
  $('cfgSearchCount').value = b.searchCount ?? 5;
  $('cfgFfmpeg').value = cfg.media?.ffmpegPath ?? '';
  const idle = cfg.idle ?? {};
  $('cfgIdleEnabled').checked = idle.enabled !== false;
  $('cfgIdleMinutes').value = idle.idleMinutes ?? 5;
  $('cfgIdleInterval').value = idle.minIntervalMinutes ?? 30;
  $('cfgTiebaBar').value = idle.tiebaBar ?? '';
  $('cfgTiebaThreads').value = idle.threads ?? 4;
  $('cfgTiebaPosts').value = idle.postsPerThread ?? 8;
  const spam = cfg.antiSpam ?? {};
  $('cfgSpamEnabled').checked = spam.enabled !== false;
  $('cfgSpamDryRun').checked = spam.dryRun === true;
  $('cfgSpamAnnounce').checked = spam.announce === true;
  $('cfgSpamRepeat').value = spam.sameTextCount ?? 7;
  $('cfgSpamRepeatWindow').value = spam.sameTextWindowSec ?? 60;
  $('cfgSpamMax').value = spam.maxMessages ?? 8;
  $('cfgSpamWindow').value = spam.windowSec ?? 10;
  $('cfgSpamMaxActions').value = spam.maxActionsPerHour ?? 10;
  $('spamHint').textContent = spam.dryRun === true
    ? '现在是演练模式：只在日志里记，不会真踢人。'
    : '现在会真踢。踢之前只放过你本人、群主和管理员。';
  $('cfgCtxEnabled').checked = Boolean(b.contextEnabled);
  $('cfgQuote').checked = Boolean(b.quoteWhenMentioned);
  $('cfgDebug').checked = Boolean(b.debug);
}

async function saveSettings() {
  const patch = {
    deepseek: {
      model: $('cfgModel').value,
      temperature: Number($('cfgTemp').value),
      maxTokens: Number($('cfgMaxTokens').value),
      timeoutMs: Number($('cfgTimeout').value),
      retries: Number($('cfgRetries').value),
      thinking: $('cfgThinking').checked,
      apiKey: $('cfgApiKey').value.trim(),
    },
    bot: {
      name: $('cfgName').value.trim(),
      persona: $('cfgPersona').value,
      style: $('cfgStyle').value,
      topics: $('cfgTopics').value,
      ownerUids: $('cfgOwnerUids').value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
      replyMode: $('cfgMode').value,
      activeProbability: Number($('cfgProb').value),
      groupCooldownSec: Number($('cfgGroupCd').value),
      replyCooldownSec: Number($('cfgReplyCd').value),
      maxRepliesPerHour: Number($('cfgMaxHour').value),
      maxChars: Number($('cfgMaxChars').value),
      contextSize: Number($('cfgCtxSize').value),
      watchVideos: $('cfgWatchVideos').checked,
      maxVideoWatchesPerHour: Number($('cfgMaxWatches').value),
      watchImages: $('cfgWatchImages').checked,
      maxImageLooksPerHour: Number($('cfgMaxImageLooks').value),
      sendStickers: $('cfgSendStickers').checked,
      useMemes: $('cfgUseMemes').checked,
      memeLimit: Number($('cfgMemeLimit').value),
      webSearch: $('cfgWebSearch').checked,
      maxSearchesPerHour: Number($('cfgMaxSearch').value),
      searchCount: Number($('cfgSearchCount').value),
      contextEnabled: $('cfgCtxEnabled').checked,
      quoteWhenMentioned: $('cfgQuote').checked,
      debug: $('cfgDebug').checked,
    },
    media: {
      ffmpegPath: $('cfgFfmpeg').value.trim(),
    },
    idle: {
      enabled: $('cfgIdleEnabled').checked,
      idleMinutes: Number($('cfgIdleMinutes').value),
      minIntervalMinutes: Number($('cfgIdleInterval').value),
      tiebaBar: $('cfgTiebaBar').value.trim(),
      threads: Number($('cfgTiebaThreads').value),
      postsPerThread: Number($('cfgTiebaPosts').value),
    },
    antiSpam: {
      enabled: $('cfgSpamEnabled').checked,
      dryRun: $('cfgSpamDryRun').checked,
      announce: $('cfgSpamAnnounce').checked,
      sameTextCount: Number($('cfgSpamRepeat').value),
      sameTextWindowSec: Number($('cfgSpamRepeatWindow').value),
      maxMessages: Number($('cfgSpamMax').value),
      windowSec: Number($('cfgSpamWindow').value),
      maxActionsPerHour: Number($('cfgSpamMaxActions').value),
    },
  };
  try {
    const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    state.config = data.config;
    state.settingsFilled = false;
    fillSettings();
    $('cfgApiKey').value = '';
    $('saveResult').textContent = '已保存';
    setTimeout(() => { $('saveResult').textContent = ''; }, 2500);
    renderStatus();
    renderStats();
  } catch (error) {
    $('saveResult').textContent = `保存失败：${error.message}`;
  }
}

async function loadStickers() {
  try {
    const data = await api('/api/stickers');
    renderStickers(data);
  } catch (error) {
    $('stickerHint').textContent = `读取表情失败：${error.message}`;
  }
}

function renderStickers(data) {
  const box = $('stickerList');
  box.innerHTML = '';
  $('stickerCount').textContent = data.count ? `（${data.count} 个）` : '（还没有）';
  if (!data.count) {
    $('stickerHint').textContent = data.lastError
      ? `没拿到：${data.lastError}`
      : '登录后点「重新拉取表情」。账号里没有收藏表情的话，这里会是空的。';
    return;
  }
  if (data.enabledStatus === false) {
    $('stickerHint').textContent = '注意：这个账号的「收藏表情」开关是关的，发出去可能被拒。';
  } else {
    $('stickerHint').textContent = '点一下直接发；机器人想甩表情时也会从这些里挑。';
  }
  for (const item of data.items) {
    const btn = document.createElement('button');
    btn.title = item.name;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = item.url;
    img.alt = item.name;
    btn.append(img);
    btn.addEventListener('click', () => sendSticker(item.id));
    box.append(btn);
  }
}

async function sendSticker(id) {
  const groupId = $('stickerGroup').value || $('manualGroup').value;
  if (!groupId) {
    $('stickerHint').textContent = '先在上面选一个群';
    return;
  }
  $('stickerHint').textContent = '正在发送…';
  try {
    await api('/api/stickers/send', { method: 'POST', body: JSON.stringify({ groupId, id }) });
    $('stickerHint').textContent = '发出去了，去抖音里看一眼';
  } catch (error) {
    $('stickerHint').textContent = `发送失败：${error.message}`;
  }
}

async function loadBrain(text = '') {
  try {
    const data = await api(`/api/brain?text=${encodeURIComponent(text)}`);
    const st = data.status ?? {};
  const memes = data.memes ?? {};
  const memeLine = memes.count
    ? `梗库 ${memes.count} 条${memes.sample?.length ? `（今天轮到：${memes.sample.join('、')}）` : ''}`
    : '梗库没接上';
  if (!st.enabled) {
      $('brainCount').textContent = `（没接记忆）｜${memeLine}`;
      $('brainHint').textContent = '把家里那个「抖音大脑」目录填进来，我就带着记忆说话了。';
      $('brainFacts').innerHTML = '';
      return;
    }
  $('brainCount').textContent = (st.hasPersona
    ? `（人设 ${st.personaChars} 字，记得 ${st.facts} 条${st.hasRecent ? '，有最近的事' : ''}）`
    : '（目录里没有 人设.md）') + `｜${memeLine}`;
    $('brainDir').value = st.dir ?? '';
    $('brainHint').textContent = st.error ? `读取有问题：${st.error}` : '读取正常，改文件不用重启。';
    const box = $('brainFacts');
    box.innerHTML = '';
    for (const fact of data.facts ?? []) {
      const li = document.createElement('li');
      li.textContent = fact;
      box.append(li);
    }
  } catch (error) {
    $('brainHint').textContent = `读取记忆失败：${error.message}`;
  }
}

/* ---------- 初始化 ---------- */

async function loadState() {
  const data = await api('/api/state');
  state.config = data.config;
  state.runtime = data.runtime;
  state.bot = data.bot;
  state.logs = data.logs ?? [];
  state.messages = data.bot?.recentMessages ?? [];
  state.replies = data.bot?.recentReplies ?? [];
  renderStatus();
  renderStats();
  renderGroups();
  renderFeed('message');
  renderFeed('reply');
  renderLogs();
  fillSettings();
}

function subscribe() {
  const es = new EventSource('/api/events');

  es.addEventListener('log', (event) => {
    state.logs.push(JSON.parse(event.data));
    if (state.logs.length > 500) state.logs.shift();
    renderLogs();
  });

  es.addEventListener('message', (event) => {
    state.messages.push(JSON.parse(event.data));
    if (state.messages.length > 100) state.messages.shift();
    renderFeed('message');
    renderStats();
  });

  es.addEventListener('reply', (event) => {
    state.replies.push(JSON.parse(event.data));
    if (state.replies.length > 60) state.replies.shift();
    renderFeed('reply');
    renderStats();
  });

  es.addEventListener('state', (event) => {
    state.runtime = JSON.parse(event.data);
    renderStatus();
    renderStats();
    renderGroups();
  });

  es.addEventListener('api-error', (event) => {
    const data = JSON.parse(event.data);
    $('testApiResult').textContent = `API 出错：${data.message}`;
  });

  es.onerror = () => {
    // 服务重启时会断开，EventSource 自己会重连，这里只是让界面别装作一切正常。
    $('statusText').textContent = '与本地服务断开，正在重连…';
  };
}

function bind() {
  $('btnConnect').addEventListener('click', async () => {
    await api('/api/connect', { method: 'POST' });
  });

  $('btnDisconnect').addEventListener('click', async () => {
    if (!confirm('退出登录后要重新扫码，确定吗？')) return;
    await api('/api/disconnect', { method: 'POST' });
  });

  $('btnToggle').addEventListener('click', async () => {
    const enabled = $('btnToggle').dataset.enabled === '1';
    const data = await api('/api/bot/enable', {
      method: 'POST',
      body: JSON.stringify({ enabled: !enabled }),
    });
    state.config.bot.enabled = data.enabled;
    renderStatus();
    renderStats();
  });

  $('btnRefreshGroups').addEventListener('click', async () => {
    $('groupHint').textContent = '正在刷新…';
    try {
      await api('/api/groups/refresh', { method: 'POST' });
    } catch (error) {
      $('groupHint').textContent = `刷新失败：${error.message}`;
    }
  });

  $('btnSms').addEventListener('click', async () => {
    await api('/api/sms', { method: 'POST', body: JSON.stringify({ code: $('smsCode').value }) });
  });

  $('btnTestApi').addEventListener('click', async () => {
    $('testApiResult').textContent = '正在调用…';
    try {
      const data = await api('/api/test-api', { method: 'POST' });
      $('testApiResult').textContent = `成功，${data.ms}ms，模型回：${data.reply}`;
    } catch (error) {
      $('testApiResult').textContent = `失败：${error.message}`;
    }
  });

  $('btnTestSearch').addEventListener('click', async () => {
    $('searchResult').textContent = '正在搜…';
    try {
      const data = await api('/api/test-search', { method: 'POST', body: JSON.stringify({ query: 'DeepSeek 最新模型' }) });
      const top = (data.results ?? []).slice(0, 3).map((item, i) => `${i + 1}. ${item.title}（${item.site || item.url}）`).join('；');
      $('searchResult').textContent = `成功，${data.ms}ms，${data.count} 条：${top || '没有结果'}`;
    } catch (error) {
      $('searchResult').textContent = `失败：${error.message}`;
    }
  });

  $('btnManualSend').addEventListener('click', async () => {
    const groupId = $('manualGroup').value;
    const text = $('manualText').value.trim();
    if (!groupId || !text) {
      $('manualResult').textContent = '先选群、再写内容';
      return;
    }
    $('manualResult').textContent = '正在发送…';
    try {
      await api('/api/send', { method: 'POST', body: JSON.stringify({ groupId, text }) });
      $('manualResult').textContent = '已发出，去抖音里看一眼有没有到';
      $('manualText').value = '';
    } catch (error) {
      $('manualResult').textContent = `发送失败：${error.message}`;
    }
  });

  $('btnSave').addEventListener('click', saveSettings);

  $('btnBrainReload').addEventListener('click', async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ bot: { brainDir: $('brainDir').value.trim() } }) });
      await api('/api/brain/reload', { method: 'POST', body: '{}' });
      await loadBrain($('brainPreview').value);
    } catch (error) {
      $('brainHint').textContent = `读取失败：${error.message}`;
    }
  });

  $('btnBrainPreview').addEventListener('click', () => loadBrain($('brainPreview').value));

  $('btnIdleRun').addEventListener('click', async () => {
    $('idleResult').textContent = '正在刷，大概半分钟…';
    try {
      const data = await api('/api/idle/run', { method: 'POST', body: '{}' });
      const r = data.result ?? {};
      $('idleResult').textContent = r.ok
        ? `刷完了：${r.bar}吧 ${r.threads} 个帖子 ${r.corpus} 条，学到的写进「贴吧学的.md」`
        : `没学成：${r.reason ?? '原因不明'}`;
      await loadBrain();
    } catch (error) {
      $('idleResult').textContent = `失败：${error.message}`;
    }
  });

  $('btnRefreshStickers').addEventListener('click', async () => {
    $('stickerHint').textContent = '正在从账号里拉…';
    try {
      await api('/api/stickers/refresh', { method: 'POST', body: '{}' });
      await loadStickers();
    } catch (error) {
      $('stickerHint').textContent = `拉取失败：${error.message}`;
    }
  });

  $('btnClearKey').addEventListener('click', async () => {    if (!confirm('清除已保存的 DeepSeek API Key？')) return;
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ deepseek: { apiKey: null } }) });
      state.config = data.config;
      state.settingsFilled = false;
      fillSettings();
      $('saveResult').textContent = 'Key 已清除';
    } catch (error) {
      $('saveResult').textContent = `清除失败：${error.message}`;
    }
  });

  $('btnClearCtx').addEventListener('click', async () => {
    if (!confirm('清空所有群的聊天上下文？')) return;
    await api('/api/context/clear', { method: 'POST', body: '{}' });
    alert('已清空');
  });
}

bind();
loadState().catch((error) => {
  $('statusText').textContent = `读取状态失败：${error.message}`;
});
loadStickers();
loadBrain();
subscribe();
