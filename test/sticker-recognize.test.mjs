/**
 * 表情包入库审核闸：**打分制 + 红线制**契约（`image-desc.mjs`）。
 *
 * ## 契约（2026-10-09 判据重写）
 *
 * ```json
 * {"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,
 *  "scores":{"nsfw":0,"violence":0,"gore":0,"ugly":0,"funny":0},
 *  "caption":"我裂开了","desc":"约20字","tags":["枚举1-3个"],"unmatched":""}
 * ```
 *
 * **模型只负责打分，收不收由代码按 `[sticker_gate]` 的阈值判。**
 *
 * 2026-10-09 的三处结构性改动（依据 `shared/tmp/2026-10-09-联络表抽样复核-session-00000000.md`）：
 * ① 新增 `funny`（有趣）—— 唯一一项**正面**分，**低于** `funnyMin` 就拒（原因 `boring`）；
 * ② 新增 `political`（涉政，用户拍板"全禁"）与 `pureText`（纯文字图）两条红线；
 * ③ `text` 从"配文 > 5 字"改成"是不是纯文字图"，`captionMaxChars` 5 → 60（降级成兜底）。
 *
 * ⚠️ **2026-10-10 部分回退（C → B）**：全量 2221 张跑完后，**`【isSticker】` 那一段回退**，
 * 因为澄清版（C）把闸门**改松了**（not-sticker 164 → 406，但 boring 同时降 121，
 * **净多收 61 张**，抽样多是真人照 / 代码截图 / 文件列表 / 主板照 / 整幅插画 —— 全该拒）。
 * 用户的原则是「宁缺毋滥」。
 *
 * **三版说清**（别把"回退"退错地方）：
 * - **A** = 2026-10-09 判据重写**之前**（示范例里有「一只猫歪头看镜头」）← **不退回这里**；
 * - **B** = 2026-10-09 判据重写**之后**（无猫 + 4 类反例：真动物随手拍 / 游戏截图 /
 *   QQ 聊天截图 / 手办实拍）← ✅ **退到这里**；
 * - **C** = 三段澄清版（在 B 之上加了"别人会不会把这张图当表情包发到群里"这句）← 回退掉它。
 * ⇒ 提示词**不许**再有「一只猫歪头看镜头」；判据句是「这图能不能当表情包用…」。
 * `screenshot` / `pureText` 两段**保留 C**（收益是实的）。详见
 * `shared/tmp/2026-10-10-isSticker回退-session-00000000.md`。
 *
 * ## 这组测试盯的十一件事（每件都对应一个会**静默**出错的地方）
 *
 * 1. **⭐ 阈值边界就卡在"低于才收"**：风险项默认 4 ⇒ 3 收 / 4 拒，**逐项测一遍**
 *    （合成一个总风险分就测不出"哪条判据在拦"，那是用户明确否掉的方案）；
 * 2. **⭐ `funny` 方向相反**：默认 `funnyMin = 3` ⇒ 2 拒（`boring`）/ 3 收；
 * 3. **⭐ 真人照片 / 截图 / 涉政 / 纯文字图没有阈值** ⇒ 命中即拒，
 *    **哪怕各项打分全是 0**（2026-10-08 用户原话：「a，真人直接砍」；
 *    2026-10-09：「涉政直接拒，不细分、不打分、不看阈值」）；
 * 4. **⭐ `isSticker`**：`false` ⇒ 拒（`not-sticker`），
 *    **哪怕各项全 0、没有配文、portrait/screenshot/political/pureText 都是 false**；
 *    四个旗标**任一缺失 / 非布尔 ⇒ `ok:false`**（未知不能当"否"，和 `scores` 同一条规矩）；
 * 5. **⭐ `pureText=true` ⇒ 拒（`text`）** —— 这就是"带字表情包被误杀"那条判据的替代品；
 *    同时 `captionChars > captionMaxChars`（兜底红线，默认 60）仍然能拒；
 * 6. **`scores` 缺项 / 越界 / 非数 ⇒ `ok:false`（fail-closed）**：
 *    只拿到四项时第五项是**未知**，未知不能当 0（那恰好是最宽松的一侧）；
 * 7. **旧契约（`safe` / `text` / `reject`）刻意不再认** —— "半认识的旧格式"
 *    会让判定变成来路不明的东西，比"没看成"危险得多；
 * 8. **两道老护栏搬到 `caption` / `desc` 上**（说"动画表情"这类它无从判断的话）；
 * 9. **提示词在 toml 里**：`gate.prompt` 给了就用它（代码里那份只是兜底），
 *    而且**配文正反例 + isSticker 正反例 + 新加的 funny/涉政/纯文字/水印那几段**都要在；
 * 10. **感知哈希是纯计算层**：`perceptualHashRgba` / `hammingDistanceHex` / `isNearDuplicate`
 *     不调模型、不看网络，见 `sticker-phash.test.mjs`；
 * 11. **`ok:false` 不重试** —— 失败路径一条调用都不多发（理由见模块注释）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_STICKER_GATE,
  DEFAULT_STICKER_PROMPT,
  MAX_STICKER_CAPTION_CHARS,
  REJECT_REASONS,
  STICKER_DESC_CHARS,
  STICKER_MAX_TOKENS_MAX,
  STICKER_MAX_TOKENS_MIN,
  STICKER_SCORE_KEYS,
  STICKER_SCORE_MAX,
  STICKER_VERDICT_FAILED,
  buildStickerInstruction,
  cleanStickerCaption,
  createImageDescriber,
  failedStickerVerdict,
  normalizeStickerGate,
  normalizeStickerScores,
  parseStickerJson,
  sanitizeStickerVerdict,
} from '../src/dsh/image-desc.mjs';
import { STICKER_TAGS } from '../src/dsh/sticker-tags.mjs';
import { createStickerLibrary } from '../src/dsh/sticker-library.mjs';
import { md5Hex } from '../src/dsh/image-cache.mjs';
import { parseToml } from '../src/dsh/toml.mjs';
import { resolveModelToml } from '../src/dsh/toml-files.mjs';
import { GIF_6FRAMES } from './fixtures/gif-bytes.mjs';

/**
 * 部署里**真正被模型读的那份**提示词所在（代码里那份只是兜底）。
 *
 * ⚠️ 2026-10-30：`[sticker_gate]` 已拆到 `qq-gugu.sticker.toml`。这里要问解析器
 * "这一刻加载器会读哪份"，别再直接拼主文件路径 —— 否则拆完就读到空提示词。
 */
// ⚠️ 2026-11-05（开源版）：这条是**集成用例**，钉的是"部署里那份 toml 的提示词
//    与代码兜底是否一致"。公开仓库里没有部署配置，所以默认跳过；
//    要看它跑，设 `QQ_GUGU_TOML=<你自己的 qq-gugu.toml>`。
const MAIN_TOML = process.env.QQ_GUGU_TOML ?? '';
const REAL_TOML = MAIN_TOML === '' ? '' : resolveModelToml(MAIN_TOML, 'sticker').path;

/** 一份合法的 PNG 头（`sniffImageMediaType` 认得出）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/**
 * **风险项**全 0（nsfw/violence/gore/ugly）—— 后面很多条靠它把"风险打分"这一维摘掉。
 * ⚠️ 不包含 `funny`：它的方向和别的项相反，基线放在 {@link OK_SCORES} 里。
 */
const ZERO_RISK = { nsfw: 0, violence: 0, gore: 0, ugly: 0 };

/**
 * 一份"普通干净表情包"的打分：风险全 0 + **funny 给到够有趣**（8 ≥ 默认 funnyMin 3）。
 *
 * ⚠️ 为什么基线不是"全 0"：`funny` 是**唯一一项正面分**，全 0 等于"完全不好笑" ⇒
 * 按默认阈值会被 `boring` 拒掉。测试的基线该是"该收的那张"，不是"什么都没有的那张"。
 */
const OK_SCORES = { ...ZERO_RISK, funny: 8 };

/** 五项**全** 0（含 funny）—— 只用在"边界 / 失败"那几条。 */
const ZERO_SCORES = { ...ZERO_RISK, funny: 0 };

/** 风险项（方向是"高了才拒"）—— 逐项测阈值边界时用，`funny` 单独测。 */
const RISK_SCORE_KEYS = STICKER_SCORE_KEYS.filter((k) => k !== 'funny');

/** 一份"看成了、什么都不沾"的模型回复（`scores` 之外都干净）。 */
function cleanRaw(over = {}) {
  return {
    isSticker: true,
    portrait: false,
    screenshot: false,
    political: false,
    pureText: false,
    scores: { ...OK_SCORES },
    caption: '',
    desc: '一只猫',
    tags: [],
    unmatched: '',
    ...over,
  };
}

/** 假装是 `ctx.llm.stream`。 */
function fakeStream(reply) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    return (async function* gen() { yield { type: 'text-delta', text: reply }; })();
  };
  fn.calls = calls;
  return fn;
}

/** 假装是 `ctx.attachments`。 */
function fakeAttachments() {
  const saved = [];
  return {
    saved,
    async saveImage(input) { saved.push(input); return { id: `att-${saved.length}`, mediaType: input.mediaType, name: input.name }; },
  };
}

const okFetch = async () => ({
  ok: true,
  async arrayBuffer() { return PNG_BYTES.buffer.slice(0); },
});

/** 一个只输出那一串 JSON 的 describer。 */
function describerWith(reply, { attachments = fakeAttachments(), stream = fakeStream(reply), gate } = {}) {
  const describer = createImageDescriber({
    attachments,
    stream,
    fetchImpl: okFetch,
    ...(gate === undefined ? {} : { stickerGate: gate }),
  });
  return { describer, stream, attachments };
}

/** 一份合法的模型 JSON（新契约）。 */
function rawJson(over = {}) {
  return JSON.stringify(cleanRaw(over));
}

// ------------------------------------------------------------------ 解析

test('parseStickerJson：原样 JSON / 代码块围栏 / 前后有寒暄，都要能抠出来', () => {
  const payload = rawJson({ caption: '寿终正寝', tags: ['卖萌可爱'] });
  assert.equal(parseStickerJson(payload).desc, '一只猫');
  // 模型很爱套 markdown 代码块
  assert.equal(parseStickerJson('```json\n' + payload + '\n```').desc, '一只猫');
  assert.equal(parseStickerJson('```\n' + payload + '\n```').desc, '一只猫');
  // 前面有寒暄
  assert.equal(parseStickerJson(`好的，这是结果：${payload}`).desc, '一只猫');
  // 尾随逗号这类"接近 JSON"的东西**不猜**（宁可当没看成）
  assert.equal(parseStickerJson('{"portrait":true,}'), null);
  // 不是对象 / 空的 / 垃圾
  assert.equal(parseStickerJson('[1,2]'), null);
  assert.equal(parseStickerJson(''), null);
  assert.equal(parseStickerJson(null), null);
  assert.equal(parseStickerJson('模型今天不想说话'), null);
});

// ------------------------------------------------------------------ 纯函数：打分 vs 阈值

test('★ sanitizeStickerVerdict：干净的输入原样通过（含 tags 归一化、desc 收拾）', () => {
  const { verdict, notes } = sanitizeStickerVerdict(cleanRaw({
    scores: { nsfw: 0, violence: 0, gore: 0, ugly: 1, funny: 8 },
    caption: '寿终正寝',
    desc: '这张图片显示：黑白漫画，少女盖被闭眼安详躺着',
    tags: ['无语无奈', '幽默搞笑', '幽默搞笑', '其他'],
  }));
  assert.deepEqual(notes, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.accept, true);
  assert.equal(verdict.reject, null);
  assert.deepEqual(verdict.rejects, []);
  assert.equal(verdict.caption, '寿终正寝', 'caption 是原样抄，不许剥前缀');
  assert.equal(verdict.desc, '黑白漫画，少女盖被闭眼安详躺着', 'desc 走 cleanDescription');
  assert.deepEqual(verdict.tags, ['无语无奈', '幽默搞笑'], '去重 + 丢掉「其他」');
});

test('★★ 阈值边界：风险项默认 4 ⇒ 3 收 / 4 拒，**逐项各测一遍**', () => {
  // 用户原话：「默认 4 分以下才能接纳」⇒ 判据是 `>=` 就拒。
  assert.equal(DEFAULT_STICKER_GATE.nsfwMax, 4);
  assert.equal(DEFAULT_STICKER_GATE.violenceMax, 4);
  assert.equal(DEFAULT_STICKER_GATE.goreMax, 4);
  assert.equal(DEFAULT_STICKER_GATE.uglyMax, 4);

  for (const key of RISK_SCORE_KEYS) {
    const three = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, [key]: 3 } }));
    assert.equal(three.verdict.accept, true, `${key}=3 该收（低于阈值）`);
    assert.equal(three.verdict.reject, null);

    const four = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, [key]: 4 } }));
    assert.equal(four.verdict.accept, false, `${key}=4 该拒（正好等于阈值）`);
    assert.equal(four.verdict.reject, key, `原因要能指到具体哪一项：${key}`);
    assert.deepEqual(four.verdict.rejects, [key]);
    assert.equal(four.verdict.ok, true, '"拒"是**看成了**之后的结论，不是"没看成"');
  }
});

test('★★⭐ `funny` 方向**相反**：低于 funnyMin 就拒（原因 `boring`），其余项照旧', () => {
  // 默认 3 ⇒ 2 拒、3 收。这是本次判据重写最要紧的一条 ——
  // 原来那几项全是负面筛选（"没毛病就收"⇒ 必然宽松，实测误收 40%）。
  assert.equal(DEFAULT_STICKER_GATE.funnyMin, 3);
  const two = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, funny: 2 } }));
  assert.equal(two.verdict.accept, false, 'funny=2 < 3 ⇒ 拒');
  assert.equal(two.verdict.reject, 'boring', '原因名是 boring，**不是** funny（否则日志读成"太有趣而拒"）');
  assert.deepEqual(two.verdict.rejects, ['boring']);
  assert.equal(two.verdict.ok, true, '"不够有趣"是看成了之后的结论');

  const three = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, funny: 3 } }));
  assert.equal(three.verdict.accept, true, 'funny=3 = 下限本身 ⇒ 收（判据是 `<` 不是 `<=`）');
  assert.equal(three.verdict.reject, null);

  // 可调：把下限压到 1，原来被拒的那张就收了
  assert.equal(
    sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, funny: 2 } }), { gate: { funnyMin: 1 } }).verdict.accept,
    true,
    'funnyMin 是配置项（toml 的 [sticker_gate] 里可调）',
  );
  // ⚠️ funny 不能掉进"风险项那套 `>=`"里：funny=10（很有趣）绝不该被拒
  const high = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, funny: 10 } }));
  assert.equal(high.verdict.accept, true, 'funny 越高越该收 —— 千万别把它当风险项比');
  assert.deepEqual(high.verdict.rejects, []);
});

test('★★ 阈值可调（各旋钮分开）：单次 gate 覆盖能改变结论', () => {
  const raw = cleanRaw({ scores: { ...OK_SCORES, nsfw: 7 } });
  assert.equal(sanitizeStickerVerdict(raw).verdict.accept, false, '默认 4 ⇒ 7 拒');
  assert.equal(
    sanitizeStickerVerdict(raw, { gate: { nsfwMax: 8 } }).verdict.accept,
    true,
    '阈值调到 8 ⇒ 7 收（这就是"不知道模型倾向只能自己测"的那个旋钮）',
  );
  // 某一项调到 0 ⇒ 只要 >0 就拒（"这一项零容忍"）
  const zero = sanitizeStickerVerdict(cleanRaw({ scores: { ...OK_SCORES, ugly: 1 } }), { gate: { uglyMax: 0 } });
  assert.equal(zero.verdict.accept, false);
  assert.equal(zero.verdict.reject, 'ugly');
});

test('★★ 多原因都留下，且按固定优先级报第一个', () => {
  const got = sanitizeStickerVerdict(cleanRaw({
    portrait: true,
    screenshot: true,
    pureText: true,
    scores: { nsfw: 9, violence: 9, gore: 0, ugly: 0, funny: 0 },
  }));
  assert.deepEqual(
    got.verdict.rejects,
    ['portrait', 'screenshot', 'text', 'boring', 'nsfw', 'violence'],
    '所有命中的原因都要留下（调阈值时要知道"是不是还有别的在拦"）',
  );
  assert.equal(got.verdict.reject, 'portrait', '第一个 = 优先级最高的那个');
  assert.deepEqual(
    [...REJECT_REASONS],
    ['political', 'portrait', 'screenshot', 'not-sticker', 'text', 'boring', 'nsfw', 'violence', 'gore', 'ugly'],
    '顺序 = 报原因的优先级（political 在最前：它是最高优先级的红线）',
  );
  // 涉政排第一：既涉政又像截图的图，日志里该先看见"涉政"
  const pol = sanitizeStickerVerdict(cleanRaw({ political: true, screenshot: true }));
  assert.equal(pol.verdict.reject, 'political');
  assert.deepEqual(pol.verdict.rejects, ['political', 'screenshot']);
});

// ------------------------------------------------------------------ 红线：真人 / 截图

test('★★ 真人照片【没有阈值】⇒ 命中即拒，哪怕各项全是 0', () => {
  const got = sanitizeStickerVerdict(cleanRaw({ portrait: true, scores: { ...OK_SCORES } }));
  assert.equal(got.verdict.ok, true, '看成了');
  assert.equal(got.verdict.accept, false, '但直接砍');
  assert.equal(got.verdict.reject, 'portrait');
  assert.equal(got.verdict.portrait, true);

  // 阈值调到最松也不该放它进来 —— 它**不在旋钮里**（用户：「a，真人直接砍」）
  const loosest = sanitizeStickerVerdict(
    cleanRaw({ portrait: true }),
    { gate: { nsfwMax: 10, violenceMax: 10, goreMax: 10, uglyMax: 10, funnyMin: 0 } },
  );
  assert.equal(loosest.verdict.accept, false, '各项阈值全放开，真人照样拒');
});

test('★★ 截图【没有阈值】⇒ 命中即拒（含手机状态栏 / 拍摄设备水印 / 翻拍屏幕）', () => {
  const got = sanitizeStickerVerdict(cleanRaw({ screenshot: true }));
  assert.equal(got.verdict.accept, false);
  assert.equal(got.verdict.reject, 'screenshot');
  assert.equal(got.verdict.screenshot, true);
  // 提示词里必须点名"拍摄设备水印算、平台水印不算"（用户拍板的那条区分）
  const p = buildStickerInstruction();
  assert.ok(p.includes('拍摄设备水印'), '缺"拍摄设备水印算截图"这条判据');
  assert.ok(p.includes('手机状态栏'), '缺"手机状态栏算截图"这条判据');
  assert.ok(p.includes('平台水印'), '缺"平台水印**不算**截图"这条区分');
  for (const brand of ['vivo X100 Pro', 'HUAWEI P60']) {
    assert.ok(p.includes(brand), `缺设备水印的例子「${brand}」`);
  }
  for (const platform of ['贴吧', '抖音', 'B站']) {
    assert.ok(p.includes(platform), `缺平台水印的例子「${platform}」`);
  }
});

test('★★⭐ 涉政【没有阈值、不细分】⇒ 命中即拒（用户拍板"全禁"）', () => {
  const got = sanitizeStickerVerdict(cleanRaw({ political: true }));
  assert.equal(got.verdict.ok, true, '"涉政"是看成了之后的结论');
  assert.equal(got.verdict.political, true);
  assert.equal(got.verdict.accept, false);
  assert.equal(got.verdict.reject, 'political');
  assert.deepEqual(got.verdict.rejects, ['political']);
  // 不做细分、不看阈值：所有旋钮全放开照样拒
  const loosest = sanitizeStickerVerdict(
    cleanRaw({ political: true }),
    { gate: { nsfwMax: 10, violenceMax: 10, goreMax: 10, uglyMax: 10, funnyMin: 0, captionMaxChars: 200 } },
  );
  assert.equal(loosest.verdict.accept, false, '涉政不在任何旋钮里');
  // 不涉政 ⇒ 这一条不拦
  assert.deepEqual(sanitizeStickerVerdict(cleanRaw({ political: false })).verdict.rejects, []);
  // 提示词里必须写明"爱国爱党的正常表达不算涉政"（用户原话）
  const p = buildStickerInstruction();
  assert.ok(p.includes('【political】'), '提示词里缺 political 判据段');
  assert.ok(
    p.includes('爱国、爱党的正常表达不算涉政'),
    '提示词里缺用户点名的那句：爱国/爱党的正常表达**不算**涉政',
  );
});

test('★★⭐ 纯文字图【没有阈值】⇒ 拒（`text` 的新含义）；带字表情包不受影响', () => {
  const got = sanitizeStickerVerdict(cleanRaw({ pureText: true }));
  assert.equal(got.verdict.ok, true);
  assert.equal(got.verdict.pureText, true);
  assert.equal(got.verdict.accept, false);
  assert.equal(got.verdict.reject, 'text', '原因名仍叫 text ⇒ 老日志 / 老计数的分桶不断档');
  // 一条 40 字的配文（原来必被 `> 5 字` 拒）现在**不拒** —— 它就是被误杀的那类带字表情包
  const longCaption = sanitizeStickerVerdict(cleanRaw({ caption: '这是一条很长很长的表情包配文用来验证旧的那条五字规则已经不在了' }));
  assert.equal(longCaption.verdict.captionChars > 5, true, '确实是长配文');
  assert.equal(longCaption.verdict.accept, true, '带字表情包该收（旧的 `> 5 字` 就是误杀的 100% 来源）');
  // 提示词里必须点名"一句短吐槽不算纯文字图"
  const p = buildStickerInstruction();
  assert.ok(p.includes('【pureText】'), '提示词里缺 pureText 判据段');
  assert.ok(p.includes('纯文字图'), '要写清判的是"纯文字图"');
});

// ------------------------------------------------------------------ 红线：这张图是不是表情包

test('★★ isSticker=false ⇒ 拒（not-sticker）—— 就是"风景照会被收进库"那条洞', () => {
  // 2026-10-09 补的缺口：风景照 / 生活照 / 商品图这些恰好 portrait=false、
  // screenshot=false、各项全 0、没有配文 ⇒ **老判据一条都不拦**，直接被收进表情包库。
  const got = sanitizeStickerVerdict(cleanRaw({ isSticker: false }));
  assert.equal(got.verdict.ok, true, '"不是表情包"是**看成了**之后的结论，不是"没看成"');
  assert.equal(got.verdict.isSticker, false);
  assert.equal(got.verdict.accept, false, 'fail-closed：不是表情包就不许收');
  assert.equal(got.verdict.reject, 'not-sticker');
  assert.deepEqual(got.verdict.rejects, ['not-sticker']);
  // 没有阈值 —— 所有旋钮全放开也照样拒（它不是旋钮，是红线）
  const loosest = sanitizeStickerVerdict(
    cleanRaw({ isSticker: false }),
    { gate: { nsfwMax: 10, violenceMax: 10, goreMax: 10, uglyMax: 10, funnyMin: 0, captionMaxChars: 200 } },
  );
  assert.equal(loosest.verdict.accept, false, 'isSticker 不在阈值旋钮里');
});

test('★ isSticker=true ⇒ 这一条不拦，其余判据照常生效', () => {
  const ok = sanitizeStickerVerdict(cleanRaw({ isSticker: true }));
  assert.equal(ok.verdict.isSticker, true);
  assert.equal(ok.verdict.accept, true);
  assert.deepEqual(ok.verdict.rejects, []);
  // 不是"isSticker=true 就全放行"
  const nsfw = sanitizeStickerVerdict(cleanRaw({ isSticker: true, scores: { ...OK_SCORES, nsfw: 9 } }));
  assert.equal(nsfw.verdict.accept, false);
  assert.equal(nsfw.verdict.reject, 'nsfw');
  const long = sanitizeStickerVerdict(cleanRaw({ isSticker: true, pureText: true }));
  assert.equal(long.verdict.reject, 'text');
});

test('★★ isSticker 缺失 / 非布尔 ⇒ `ok:false`（fail-closed，未知不能当"不是"）', () => {
  for (const value of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    const raw = cleanRaw();
    if (value === undefined) delete raw.isSticker; else raw.isSticker = value;
    const { verdict, notes } = sanitizeStickerVerdict(raw);
    assert.equal(verdict.ok, false, `isSticker=${JSON.stringify(value)} 该算"没看成"`);
    assert.equal(verdict.accept, false, 'fail-closed：没看成就不许收');
    assert.equal(verdict.reject, null, '没看成**不许**伪装成"判它不是表情包"');
    assert.deepEqual(verdict.rejects, []);
    assert.equal(verdict.isSticker, false, '没看成时这个字段和 portrait/screenshot 一样是 false');
    assert.ok(notes.some((n) => n.startsWith('isSticker-')), `要留下原因，实际 notes=${JSON.stringify(notes)}`);
  }
  // "模型没答这个字段"与"答了但不是布尔"要能分开（前者改提示词，后者管模型）
  const missing = sanitizeStickerVerdict({ scores: { ...OK_SCORES }, desc: 'x' });
  assert.ok(missing.notes.includes('isSticker-missing'));
  const invalid = sanitizeStickerVerdict({ scores: { ...OK_SCORES }, desc: 'x', isSticker: 'true' });
  assert.ok(invalid.notes.includes('isSticker-invalid'));
  assert.equal(invalid.verdict.ok, false, '字符串 "true" 不算守约（不猜）');
});

test('★★⭐ `political` / `pureText` 也必须真布尔（缺失 ⇒ 没看成，不重试）', () => {
  for (const name of ['political', 'pureText']) {
    for (const value of [undefined, null, 'true', 1, {}]) {
      const raw = cleanRaw();
      if (value === undefined) delete raw[name]; else raw[name] = value;
      const { verdict, notes } = sanitizeStickerVerdict(raw);
      assert.equal(verdict.ok, false, `${name}=${JSON.stringify(value)} 该算"没看成"`);
      assert.equal(verdict.accept, false, 'fail-closed');
      assert.ok(notes.some((n) => n.startsWith(`${name}-`)), `notes 里要能看出是哪个旗标：${JSON.stringify(notes)}`);
    }
  }
  // 两个旗标都要在失败判定里给出确定值（调用方不用写防御）
  assert.equal(STICKER_VERDICT_FAILED.political, false);
  assert.equal(STICKER_VERDICT_FAILED.pureText, false);
  assert.equal(STICKER_VERDICT_FAILED.phash, '');
});

// ------------------------------------------------------------------ 配文长度

test('★★ 配文长度**红线**：默认 120（兜底），而且**配文原样抄**不许剥前缀', () => {
  // 2026-10-09：从 5 提到 120。原来那条 `> 5 字` 是**误杀的 100% 来源**（抽样 14/14）。
  // 120 = 实测最长真表情包配文（59 字）的 2 倍余量。
  assert.equal(MAX_STICKER_CAPTION_CHARS, 120);
  for (const caption of ['寿终正寝啊', '今天也要开心鸭', '熊猫头表情包，配文调侃家庭条件']) {
    const v = sanitizeStickerVerdict(cleanRaw({ caption }));
    assert.equal(v.verdict.accept, true, `「${caption}」是正常的表情包配文，不该拒`);
  }
  // 实测最长的那张（59 字）必须收得住 —— 它就是被老规则误杀的那批里最长的一条。
  // 这里刻意取一段**比 59 更长**（66 字）的配文，把余量也钉住。
  const longestReal = '这是一段很长的梗图配文'.repeat(6);   // 66 字
  const longestLen = Array.from(longestReal).length;
  assert.ok(longestLen > 59 && longestLen <= MAX_STICKER_CAPTION_CHARS, `夹具该比实测最长的 59 字更长，实际 ${longestLen}`);
  assert.equal(sanitizeStickerVerdict(cleanRaw({ caption: longestReal })).verdict.accept, true, '真梗图的长配文要能过');

  // 长到不可能是表情包（> 120 字）⇒ 仍然拒（这是"兜底"，不是主判据）
  const long = '这是一段非常长的文字'.repeat(12);   // 120 字
  assert.equal(Array.from(long).length, 120);
  assert.equal(sanitizeStickerVerdict(cleanRaw({ caption: long })).verdict.accept, true, '120 = 红线本身 ⇒ 收');
  const longer = `${long}啊`;
  const v2 = sanitizeStickerVerdict(cleanRaw({ caption: longer }));
  assert.equal(v2.verdict.accept, false);
  assert.equal(v2.verdict.reject, 'text');

  // 🔴 这条钉的是 2026-10-09 修掉的那个**死旋钮**：
  //    老实现是"先截到 MAX_STICKER_CAPTION_KEEP(40) → 再判 > captionMaxChars"，
  //    所以 captionMaxChars 一旦 > 40 就**永远不可能命中**（配置写着、日志正常、一次都不触发）。
  //    现在：判定用**未截断的真长度**，落盘的那份才截断。
  assert.equal(Array.from(v2.verdict.caption).length, 40, '落盘的 caption 仍然截到 40（日志可读）');
  assert.equal(v2.verdict.captionChars, 121, '但 captionChars 报的是**真长度**（判定看的是它）');
  // 对照：121 字的配文，在 captionMaxChars=120 与 150 下结论必须不同（旋钮真的接上了）
  assert.equal(sanitizeStickerVerdict(cleanRaw({ caption: longer })).verdict.reject, 'text');
  assert.equal(
    sanitizeStickerVerdict(cleanRaw({ caption: longer }), { gate: { captionMaxChars: 150 } }).verdict.accept,
    true,
    'captionMaxChars=150 ⇒ 121 字的配文放行 —— 证明这个旋钮没有变成死代码',
  );

  // ⚠️ 配文走的是 cleanStickerCaption 而**不是** cleanDescription：
  //    后者会剥掉"图上写着"这类前缀，那等于**改证据**。
  const verbatim = sanitizeStickerVerdict(cleanRaw({ caption: '图上写着五个字' }));
  assert.equal(verbatim.verdict.caption, '图上写着五个字');
  assert.equal(verbatim.verdict.captionChars, 7);

  // 边界可配
  assert.equal(
    sanitizeStickerVerdict(cleanRaw({ caption: '今天也要开心鸭' }), { gate: { captionMaxChars: 7 } }).verdict.accept,
    true,
    'captionMaxChars 可调',
  );
  assert.equal(
    sanitizeStickerVerdict(cleanRaw({ caption: '今天也要开心鸭' }), { gate: { captionMaxChars: 5 } }).verdict.reject,
    'text',
    '调回 5 就是老行为（这个旋钮还在，只是默认值不再是它）',
  );
  // 没配文 ⇒ 空串、0 字（"帽子上的 JOJO 不算"落到这里就是 caption 为空）
  const none = sanitizeStickerVerdict(cleanRaw({ caption: '' }));
  assert.equal(none.verdict.caption, '');
  assert.equal(none.verdict.captionChars, 0);
  assert.equal(none.verdict.accept, true);
});

test('★ cleanStickerCaption：换行折成空格、去首尾空白，但**一个字都不删**', () => {
  assert.equal(cleanStickerCaption('  我裂开了  '), '我裂开了');
  assert.equal(cleanStickerCaption('我裂开\n了'), '我裂开 了');
  assert.equal(cleanStickerCaption('【震惊】'), '【震惊】', '方括号是配文的一部分，不许剥');
  assert.equal(cleanStickerCaption(null), '');
  assert.equal(cleanStickerCaption(undefined), '');
});

// ------------------------------------------------------------------ scores 必须完整

test('★★ `scores` 缺项 / 越界 / 非数 ⇒ `ok:false`（fail-closed）', () => {
  const bad = [
    undefined, null, {}, [], '0',
    { nsfw: 0, violence: 0, gore: 0, ugly: 0 },                    // 少 funny 一项
    { nsfw: 0, violence: 0, gore: 0, ugly: 11, funny: 0 },         // 越界（不夹，算不守约）
    { nsfw: -1, violence: 0, gore: 0, ugly: 0, funny: 0 },         // 越界
    { nsfw: 'x', violence: 0, gore: 0, ugly: 0, funny: 0 },        // 不是数
    { nsfw: NaN, violence: 0, gore: 0, ugly: 0, funny: 0 },
  ];
  for (const scores of bad) {
    const { verdict, notes } = sanitizeStickerVerdict(cleanRaw({ scores }));
    assert.equal(verdict.ok, false, `scores=${JSON.stringify(scores)} 该算"没看成"`);
    assert.equal(verdict.accept, false, 'fail-closed：没看成就不许收');
    assert.deepEqual(verdict.rejects, []);
    assert.ok(notes.includes('scores-invalid'), '原因要记进 notes');
  }
});

test('★ `scores` 的数字字符串认（弱模型很爱这么写），但仍是 0-10 才算数', () => {
  const ok = sanitizeStickerVerdict(cleanRaw({ scores: { nsfw: '0', violence: '0', gore: '0', ugly: '2', funny: '8' } }));
  assert.equal(ok.verdict.ok, true);
  assert.equal(ok.verdict.accept, true);
  assert.equal(ok.verdict.scores.ugly, 2, '要变成真数字，不是字符串');
  assert.equal(ok.verdict.scores.funny, 8, 'funny 也走同一条"数字字符串认"的规矩');
  assert.equal(sanitizeStickerVerdict(cleanRaw({ scores: { nsfw: '11', violence: '0', gore: '0', ugly: '0', funny: '8' } })).verdict.ok, false);
});

test('★ normalizeStickerScores 直接测：五项齐全 + 0-10 才算合格', () => {
  assert.deepEqual(
    normalizeStickerScores({ nsfw: 0, violence: 1, gore: 2, ugly: 10, funny: 7 }),
    { nsfw: 0, violence: 1, gore: 2, ugly: 10, funny: 7 },
  );
  assert.equal(STICKER_SCORE_MAX, 10);
  assert.deepEqual([...STICKER_SCORE_KEYS], ['nsfw', 'violence', 'gore', 'ugly', 'funny']);
  assert.equal(normalizeStickerScores({ nsfw: 0, violence: 1, gore: 2 }), null);
  assert.equal(normalizeStickerScores({ nsfw: 0, violence: 1, gore: 2, ugly: 10, funny: 10.5 }), null, '越界（不夹）');
  // 0-10 之间的**小数是合法的**（契约是"0-10 的数"，不是"整数"）—— 老实现就是这样，别收紧
  assert.equal(normalizeStickerScores({ nsfw: 0, violence: 1, gore: 2, ugly: 10, funny: 0.5 }).funny, 0.5);
});

test('★★ 没看成 ⇒ `ok:false` + `accept:false`（fail-closed，调用方不许当"可以收"）', () => {
  for (const bad of [null, undefined, '不是对象', 42, [1, 2], {}]) {
    const { verdict, notes } = sanitizeStickerVerdict(bad);
    assert.equal(verdict.ok, false, `${JSON.stringify(bad)} 该被判为"没看成"`);
    assert.equal(verdict.accept, false);
    assert.equal(verdict.reject, null);
    assert.deepEqual(verdict.rejects, []);
    assert.deepEqual(verdict.tags, []);
    assert.equal(verdict.caption, '');
    assert.equal(verdict.captionChars, 0);
    assert.equal(verdict.desc, '');
    assert.equal(verdict.isSticker, false);
    assert.equal(verdict.portrait, false);
    assert.equal(verdict.screenshot, false);
    assert.equal(verdict.political, false);
    assert.equal(verdict.pureText, false);
    assert.deepEqual(verdict.scores, ZERO_SCORES);
    assert.equal(verdict.phash, '', '没看成时 phash 也是空串（调用方不用写防御）');
    assert.ok(notes.length > 0);
  }
  assert.equal(STICKER_VERDICT_FAILED.ok, false);
  assert.equal(STICKER_VERDICT_FAILED.accept, false);
  // 那份常量是**冻结**的（防止有人就地改它），要往下传必须用工厂
  assert.throws(() => { STICKER_VERDICT_FAILED.tags.push('x'); }, TypeError);
  const copy = failedStickerVerdict();
  copy.tags.push('x');
  copy.scores.nsfw = 5;
  assert.deepEqual(STICKER_VERDICT_FAILED.tags, [], '工厂给的是副本，改不动原件');
  assert.equal(STICKER_VERDICT_FAILED.scores.nsfw, 0);
});

test('★★ 旧契约（safe / text / reject）**刻意不再认** —— 防"半认识的旧格式"', () => {
  // 一份老提示词产出的回复：字段名全对不上新契约
  const legacy = sanitizeStickerVerdict({
    safe: true, reject: null, text: '寿终正寝', desc: '一只猫', tags: [], unmatched: '',
  });
  assert.equal(legacy.verdict.ok, false, '没有 scores ⇒ 算没看成（不是"安全"）');
  assert.equal(legacy.verdict.accept, false);
  assert.equal(legacy.verdict.caption, '', '旧字段 text 不会被当配文收下');
  // `safe:false` 也不再是判据 —— 打分制里模型说了不算
  const oldUnsafe = sanitizeStickerVerdict({
    safe: false, reject: 'nsfw', text: '', desc: 'x', tags: [], unmatched: '',
  });
  assert.equal(oldUnsafe.verdict.ok, false);
});

// ------------------------------------------------------------------ 老护栏

test('★★ 护栏搬到 `caption`/`desc`：说"动画表情"这类话就被丢掉那一项', () => {
  const t = sanitizeStickerVerdict(cleanRaw({ caption: '动画表情' }));
  assert.equal(t.verdict.caption, '');
  assert.equal(t.verdict.captionChars, 0);
  assert.ok(t.notes.includes('caption-looks-like-judgement'));

  const t2 = sanitizeStickerVerdict(cleanRaw({ caption: '[动画表情]' }));
  assert.equal(t2.verdict.caption, '');

  const d = sanitizeStickerVerdict(cleanRaw({ desc: '一张会动的动图表情' }));
  assert.equal(d.verdict.desc, '');
  assert.ok(d.notes.includes('desc-looks-like-judgement'));

  // 画面里真的印着"视频"两个字时**不算**（代码判定比提示词窄，别误伤真话）
  const ok = sanitizeStickerVerdict(cleanRaw({ caption: '视频' }));
  assert.equal(ok.verdict.caption, '视频');
});

test('★ unmatched：模型没填就用"它写了但不在枚举里"的词，且截到 8 个字', () => {
  const auto = sanitizeStickerVerdict(cleanRaw({ tags: ['阴阳怪气'] }));
  assert.equal(auto.verdict.unmatched, '阴阳怪气');
  assert.deepEqual(auto.verdict.tags, []);
  const said = sanitizeStickerVerdict(cleanRaw({ tags: [], unmatched: '自造词啊啊啊啊啊啊啊啊啊' }));
  assert.equal(Array.from(said.verdict.unmatched).length, 8);
});

// ------------------------------------------------------------------ 提示词

test('★ buildStickerInstruction：JSON schema、17 个枚举、"大约"而不是"不超过"', () => {
  const p = buildStickerInstruction();
  assert.match(p, /只输出一个 JSON 对象/);
  for (const key of ['"isSticker"', '"portrait"', '"screenshot"', '"political"', '"pureText"', '"scores"', '"nsfw"', '"violence"', '"gore"', '"ugly"', '"funny"', '"caption"', '"desc"', '"tags"', '"unmatched"']) {
    assert.ok(p.includes(key), `提示词里缺字段 ${key}`);
  }
  for (const tag of STICKER_TAGS) assert.ok(p.includes(tag), `提示词里缺枚举值 ${tag}`);
  assert.match(p, /原样抄/);
  assert.ok(p.includes(`大约 ${STICKER_DESC_CHARS} 个字`), 'desc 要"大约 N 个字"');
  assert.doesNotMatch(p, /不超过/, '"不超过 N 字"会让模型只写十来个字（用户点名过的坑）');
  assert.ok(p.includes('真人照片'), 'portrait 判据（小鲸鱼的红线）');
  assert.ok(p.includes('屏幕，或屏幕的复制品'), 'screenshot 判据（2026-10-09 扩到"翻拍屏幕/设备水印"）');
  assert.ok(p.includes('0-10') || p.includes('0 到 10'), '打分的量程要写清');
  for (const w of ['动画', '动图', '视频', '会动', '循环']) {
    assert.ok(p.includes(w), `禁词表里的「${w}」要在提示词里出现（告诉模型别写）`);
  }
});

test('★★⭐ `ugly` 的定义**收窄**了：只管字面意义的脏丑，"扭曲变形"交给 funny', () => {
  const p = buildStickerInstruction();
  // 老的写法必须**不在**了 —— 它是"梗图笑点被当成缺陷"的根因（抽样里 2 张被它误杀）
  assert.equal(
    p.includes('- ugly 丑：扭曲变形'),
    false,
    '⚠️ 「扭曲变形」必须从 ugly 的定义里拿掉（那是梗图笑点，不是缺陷）',
  );
  assert.ok(p.includes('字面意义的丑'), 'ugly 的新定义要落在"字面意义的丑/脏"上');
  assert.ok(p.includes('扭曲'), '要**主动告诉模型**"扭曲不算 ugly"（不提它就还会照着老印象判）');
  assert.ok(p.includes('猫弓起背') || p.includes('猫弓起背把身体扭成奇怪形状'), '要给出那个具体例子（实测被误杀的那张）');
  assert.ok(p.includes('funny'), 'funny 这一项要在提示词里');
  assert.ok(p.includes('越高越有趣'), 'funny 的方向要写清（唯一一项正面分）');
});

test('★★ 提示词里必须有**配文的正反两组例子**（用户：「还得详细告诉他」）', () => {
  const p = buildStickerInstruction();
  // 判据本身：配文 ≠ 图上所有字
  assert.ok(p.includes('不是图上所有字'), '要明确说"不是图上所有字"');
  // 正面（要数进去）
  for (const good of ['我裂开了', '你说啥？', '震惊']) {
    assert.ok(p.includes(good), `缺正面例子「${good}」（配文）`);
  }
  // 反面（不要数）—— 用户点名的帽子上的 JOJO
  for (const bad of ['JOJO', 'ADIDAS', '便利店', '书本封面']) {
    assert.ok(p.includes(bad), `缺反面例子「${bad}」（不是配文）`);
  }
  assert.ok(p.includes('帽子'), '要说清 JOJO 是**帽子上的**（不然模型不知道它为什么不算）');
  assert.ok(p.includes('衣服'), '要说清 ADIDAS 是**衣服上的**');
  assert.ok(p.includes('算配文') && p.includes('不算配文'), '两组例子要各自成组');
  assert.ok(p.includes('聊天记录截图'), '截图里的字要单独点出来（它另有判据）');
});

test('★★ 提示词里必须有**是不是表情包的正反两组例子**（判据句 + 正反例）', () => {
  const p = buildStickerInstruction();
  assert.ok(p.includes('"isSticker"'), 'JSON 契约里要有 isSticker');
  assert.ok(p.includes('【isSticker】'), '要有 isSticker 的判据段');
  // 判据句：说清这条判的是**能不能当表情包用**，而不是好不好看 / 干不干净
  //   ⚠️ 2026-10-10 回退：判据句从澄清版的"别人会不会把这张图当表情包发到群里"
  //      退回 2026-10-09 判据重写后的这句（澄清版把闸门改松了、净多收 61 张，见
  //      shared/tmp/2026-10-10-isSticker回退-session-00000000.md）。
  assert.ok(
    p.includes('这图能不能当表情包用') && p.includes('跟好不好看、干不干净无关'),
    '判据句要说清"判的是能不能当表情包用"，且与"好不好看/干不干净"无关',
  );
  // 正面（是表情包 / 梗图）
  //   ⚠️ 2026-10-10 回退到 2026-10-09 判据重写后的那一版：**没有**「一只猫歪头看镜头」
  //      （那句是它在教模型"真猫照算表情包"，正是那次重写要修的东西）。
  for (const good of ['动漫角色抱头', '熊猫头梗图', '纯文字梗图']) {
    assert.ok(p.includes(good), `缺正面例子「${good}」`);
  }
  // 反面（不是表情包）—— 抽样报告点名的四类误收主力
  // ⚠️ 2026-10-09 改成**钉类别关键词**，不再钉一整句连续原文：
  //    提示词重写成分类写法后，语义没变但这些例子不再连成一句。
  //    **钉整句会让"换个说法"变成测试失败** —— 那就成了"为了过测试而写提示词"，本末倒置。
  //    ⇒ 判据：**每一类都必须还在**（下面的关键词一个都不能少）。
  //   ⚠️ 「实物照」「商品图」这两个词回退后的这一版里没有（它们只出现在后面的
  //      「判断方法」那句里，而那句不是反面例子组）⇒ 这里按**实际措辞**钉
  //      「真实动物照片」（随手拍的猫狗仓鼠鸟）+「商品页截图」。
  for (const bad of [
    '真实动物照片', '游戏画面截图', 'QQ 聊天界面截图', '手办 / 玩偶的实拍',
    '风景照', '生活照', '商品页截图',
    '快递单', '证件', '地图', '报表', '纯文档截屏',
  ]) {
    assert.ok(p.includes(bad), `缺反面例子「${bad}」`);
  }
  assert.ok(
    p.includes('下面这些 isSticker = true：') && p.includes('下面这些 isSticker = false：'),
    '两组例子要各自成组（和 caption 那段同一个写法）',
  );
  assert.ok(p.includes('表达情绪或吐槽'), '要把"有没有吐槽/表达情绪的意图"说清');
});

test('★★⭐ 提示词**不许**再把"真猫照片"当 isSticker=true 的示范例', () => {
  const p = buildStickerInstruction();
  // 这句话是误收最大一类（宠物实拍 9/80）的根因：它等于明文教模型"真猫照也算表情包"。
  // ⚠️ 2026-10-10：回退**没有**退到最早那一版（那版有这句）—— 退的是 2026-10-09
  //    判据重写后的版本，那句**仍然不许有**。回退只退了澄清版新加的判据句
  //    （"别人会不会把这张图当表情包发到群里"）。见回退报告。
  assert.equal(
    p.includes('一只猫歪头看镜头'),
    false,
    '⚠️ 「一只猫歪头看镜头」不许出现在 isSticker=true 的例子里 —— 那是在教模型把真猫照算表情包',
  );
  // 但**也不能**走到另一个极端："有动物就 false"。用户明确认可过
  // 「狗张嘴咆哮、白猫瞪眼吐舌头」那些是表情包 ⇒ 判据要落在"有没有戏 / 有没有配字"上。
  assert.ok(p.includes('真实动物的照片也可以是表情包'), '要保住用户那条：真实动物照片也可以是表情包');
  assert.ok(p.includes('有"戏"') || p.includes('有戏'), '区别要写在"表情/姿态有没有戏"上，不是"拍的还是画的"');
  assert.ok(p.includes('狗张大嘴巴咆哮'), '缺"有戏"的正面例子（用户认可过的那类）');
  assert.ok(p.includes('猫趴在路边抬头看镜头'), '缺"没戏"的反面例子（随手拍的那种）');
  assert.ok(p.includes('表情 / 姿态有戏'), '要明说区别是"表情/姿态有戏"');
  // 随手拍的真动物照在反面例子里点名（回退后的这一版重新写进来了）
  assert.ok(p.includes('真实动物照片'), '反面例子里要点名"真实动物照片"（随手拍的猫狗仓鼠鸟）');
  assert.ok(
    p.includes('你会当表情包存下来，还是当照片划过去'),
    '缺那句最贴近真实用途的口径（"存下来还是划过去"）',
  );
});

test('★★ 真 toml 里的提示词也带着这两组例子（模型读的是 toml 那份，代码兜底不算数）', {
  skip: fs.existsSync(REAL_TOML) ? undefined : `没找到 ${REAL_TOML}`,
}, () => {
  const parsed = parseToml(fs.readFileSync(REAL_TOML, 'utf8'));
  const p = String(parsed?.sticker_gate?.prompt ?? '');
  assert.ok(p.includes('"isSticker"'), '真 toml 的 JSON 契约里要有 isSticker');
  assert.ok(p.includes('下面这些 isSticker = true：') && p.includes('下面这些 isSticker = false：'));
  // ⚠️ 钉**类别关键词**，不钉一整句连续原文（理由见上面那条测试的注释）。
  //    ⚠️ 2026-10-10 回退：退到 2026-10-09 判据重写后的那一版 ⇒ 游戏画面截图 /
  //       QQ 聊天界面截图 / 手办 · 玩偶实拍 这几类**又回到** isSticker 的反面例子里。
  for (const s of [
    '动漫角色抱头', '熊猫头梗图', '纯文字梗图',
    '真实动物照片', '游戏画面截图', 'QQ 聊天界面截图', '手办 / 玩偶的实拍',
    '风景照', '生活照', '商品页截图',
    '快递单', '证件', '地图', '报表', '纯文档截屏',
    '真实动物的照片也可以是表情包', '狗张大嘴巴咆哮',
  ]) {
    assert.ok(p.includes(s), `真 toml 里缺例子「${s}」`);
  }
  // ⚠️ 2026-10-10 回退**没有**退到最早那一版 ⇒ 「一只猫歪头看镜头」仍然不许有。
  assert.equal(p.includes('一只猫歪头看镜头'), false, '真 toml 里不许再有"真猫照 = 表情包"那个示范例');
  assert.equal(p.includes('扭曲变形'), false, '真 toml 里不许再有 ugly 定义里的"扭曲变形"');
});

test('★ 提示词：多帧说"同一个文件的 N 个画面"，且**绝不说"这是一张动图"**', () => {
  const multi = buildStickerInstruction({ frames: 4 });
  assert.ok(multi.includes('4 个画面'));
  assert.doesNotMatch(multi, /这是一张动图/);
  const single = buildStickerInstruction();
  assert.ok(single.includes('这是一张 QQ 表情包'));
});

test('★★ 提示词来自 toml：`gate.prompt` 给了就用它（代码里那份只是兜底）', () => {
  const custom = '自定义提示词 {intro} | {descChars} | {tags} | {banned}';
  const got = buildStickerInstruction({ gate: { prompt: custom } });
  assert.ok(got.startsWith('自定义提示词 这是一张 QQ 表情包。'), '满上占位符 {intro}');
  assert.ok(got.includes(`| ${STICKER_DESC_CHARS} |`), '满上 {descChars}');
  assert.ok(got.includes(STICKER_TAGS[0]), '满上 {tags}');
  assert.ok(got.includes('动画'), '满上 {banned}');

  // toml 留空 / 只有空白 ⇒ 回退代码兜底（注意：兜底也要**填完占位符**再比）
  const fallback = buildStickerInstruction();
  assert.equal(buildStickerInstruction({ gate: { prompt: '' } }), fallback);
  assert.equal(buildStickerInstruction({ gate: { prompt: '   ' } }), fallback);
  // 兜底那份自己也不该留占位符（留一个就是"模型看到 {tags} 这四个字符"）
  assert.doesNotMatch(fallback, /\{(?:intro|descChars|tags|banned)\}/);
  assert.ok(DEFAULT_STICKER_PROMPT.includes('{intro}'), '代码兜底是**模板**（占位符还在），填完才发给模型');
});

test('★ normalizeStickerGate：非法值夹到边界、缺项取默认，且**不抛**', () => {
  assert.deepEqual(normalizeStickerGate(null), { ...DEFAULT_STICKER_GATE });
  assert.deepEqual(normalizeStickerGate(undefined), { ...DEFAULT_STICKER_GATE });
  assert.deepEqual(normalizeStickerGate('不是对象'), { ...DEFAULT_STICKER_GATE });
  const clamped = normalizeStickerGate({ nsfwMax: 40, violenceMax: -3, captionMaxChars: 999, provider: '  local  ', model: 'x' });
  assert.equal(clamped.nsfwMax, 10, '上界夹到满分');
  assert.equal(clamped.violenceMax, 0, '下界夹到 0');
  assert.equal(clamped.captionMaxChars, 200);
  assert.equal(clamped.provider, 'local', 'provider 去首尾空白');
  assert.equal(normalizeStickerGate({ nsfwMax: '4' }).nsfwMax, 4, '数字字符串认');
  assert.equal(normalizeStickerGate({ nsfwMax: 'abc' }).nsfwMax, 4, '认不出就用默认');
});

// ---------------------------------------------------------------- maxTokens（2026-10-10）
//
// 背景：这个数原来**硬编码**在「认」那次调用里（420）。它够不够用取决于
// **模型有没有隐藏思维链**，不取决于模型强不强 —— 云端模型有，同一个 420
// 就会把 JSON 切断 ⇒ `ok:false` ⇒ fail-closed 拒掉，而表现像"模型判得严"。
// 所以它必须可配，而且**越界被夹紧必须留痕**（同这个文件/这一节的其他阈值）。

test('★ maxTokens：默认 420（保持原硬编码值不变）、可配、越界夹到边界', () => {
  assert.equal(DEFAULT_STICKER_GATE.maxTokens, 420, '默认必须还是 420 —— 不改行为');
  assert.equal(normalizeStickerGate({}).maxTokens, 420, '没写就用默认');
  assert.equal(normalizeStickerGate({ maxTokens: 2000 }).maxTokens, 2000, '云端够用的值要能配进来');
  assert.equal(normalizeStickerGate({ maxTokens: '2000' }).maxTokens, 2000, '数字字符串认');
  assert.equal(
    normalizeStickerGate({ maxTokens: STICKER_MAX_TOKENS_MAX + 1 }).maxTokens,
    STICKER_MAX_TOKENS_MAX,
    '上界夹住（挡住"多写一位"那种笔误）',
  );
  assert.equal(
    normalizeStickerGate({ maxTokens: 1 }).maxTokens,
    STICKER_MAX_TOKENS_MIN,
    '下界夹住（低于它连一份 JSON 契约都装不下 = 配了就等于全拒）',
  );
  assert.equal(normalizeStickerGate({ maxTokens: 'abc' }).maxTokens, 420, '认不出就用默认');
});

test('★★ maxTokens 真的进了那次调用（不是读进来搁着）', async () => {
  const { describer, stream } = describerWith(rawJson(), { gate: { maxTokens: 2000 } });
  await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(stream.calls[0].maxTokens, 2000, '「认」那一次必须用 gate.maxTokens');
  assert.equal(describer.stats().stickerGate.maxTokens, 2000, '调试快照里也要能看见它');

  // 不配就走默认 —— 这条钉住"默认值仍是 420"，防止有人顺手把它改成别的
  const base = describerWith(rawJson());
  await base.describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(base.stream.calls[0].maxTokens, 420);
});

test('★★ 被 maxTokens 截断必须留痕（finish=max-tokens）—— 不许当成"模型判它不合格"', async () => {
  // 现实场景：云端模型把预算花在隐藏思维链上 ⇒ JSON 断在半句 ⇒ 解析失败 ⇒ ok:false。
  // 这里就用"半截 JSON + finish:max-tokens"复现它。
  const half = '{"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,"scores":{"nsfw":0,"viol';
  const stream = (opts) => (async function* gen() {
    yield { type: 'text-delta', text: half };
    // ⚠️ DSH 对 provider `finish_reason:'length'` 的叫法是 `max-tokens`。
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  })();
  const saved = [];
  const describer = createImageDescriber({
    attachments: fakeAttachments(),
    stream,
    fetchImpl: okFetch,
    stickerGate: { maxTokens: 420 },
    stickerAudit: { save: async (input) => { saved.push(input); return null; }, stats: () => ({}) },
  });
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });

  assert.equal(got.ok, false, 'JSON 半截 ⇒ 拿不到完整判定');
  assert.equal(describer.stats().stickerFailed, 1, '按不可信处理（fail-closed）');

  assert.equal(saved.length, 1, '留样仍要落一份（含没看成的）');
  const notes = saved[0].notes;
  assert.ok(notes.includes('finish:max-tokens'), `留样里要记下结束原因，实际 ${JSON.stringify(notes)}`);
  assert.ok(
    notes.includes('truncated-by-maxTokens'),
    '⚠️ 必须有一条能一眼筛出来的截断标记 —— 事后要回答"这批里有多少张是被截断的"',
  );
  assert.equal(
    saved[0].thresholds.maxTokens, 420,
    '留样要记下**当时生效的** maxTokens（阈值会调，事后得知道是按哪个数跑的）',
  );
});

test('★ 没被截断时不留"被截断"的痕（别把正常结束也标成截断）', async () => {
  const stream = (opts) => (async function* gen() {
    yield { type: 'text-delta', text: rawJson({ scores: { nsfw: 0, violence: 0, gore: 0, ugly: 0, funny: 8 } }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const saved = [];
  const describer = createImageDescriber({
    attachments: fakeAttachments(),
    stream,
    fetchImpl: okFetch,
    stickerAudit: { save: async (input) => { saved.push(input); return null; }, stats: () => ({}) },
  });
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, true);
  assert.deepEqual(saved[0].notes, ['finish:stop'], '正常结束只记原因，不该出现截断标记');
});

// ------------------------------------------------- enableThinking（2026-10-10）
//
// 背景：同一份提示词、20 张图的 A/B 实测 —— 关掉思考**快 4.8×**（12.52s → 2.60s）、
// `reasoning_tokens` 14717 → 0，而收/拒判定**完全一致**（A 组 8/8、B 组 6/6）。
//
// ⚠️ 但它**不是**"往请求体塞 `enable_thinking`"：DSH 的 LLM 环缝只认契约字段
// （`GenerateOptions.reasoningEffort` 是唯一能表达"要不要思考"的那个），
// 多出来的键会被适配器**静默丢掉**。所以这一项只驱动 `reasoningEffort`。

test('★ enableThinking：默认 false（= 老行为）、只认真布尔、认不出就回退', () => {
  assert.equal(DEFAULT_STICKER_GATE.enableThinking, false, '默认必须是不思考 —— 它就是加这个键之前的行为');
  assert.equal(normalizeStickerGate({}).enableThinking, false, '没写就用默认');
  assert.equal(normalizeStickerGate({ enableThinking: false }).enableThinking, false);
  assert.equal(normalizeStickerGate({ enableThinking: true }).enableThinking, true, '显式打开要能读到');
  // ⚠️ 只认真布尔：`"false"` / `0` / `1` 这类值的语义有歧义，猜错的方向是
  //    "把审核闸的思考悄悄打开或关掉"，而且**不报错、计数正常** ⇒ 一律回退 + 留 warn。
  assert.equal(normalizeStickerGate({ enableThinking: 'false' }).enableThinking, false, '字符串不认');
  assert.equal(normalizeStickerGate({ enableThinking: 'true' }).enableThinking, false, '字符串 true 也不认（免得方向猜反）');
  assert.equal(normalizeStickerGate({ enableThinking: 0 }).enableThinking, false);
  assert.equal(normalizeStickerGate({ enableThinking: null }).enableThinking, false);
});

test('★★ enableThinking 真的进了那次调用：false ⇒ reasoningEffort=off；true ⇒ **不发这个字段**', async () => {
  // false（默认）：`'off'` —— 和加这个旋钮之前**逐字节相同**（`image-desc.mjs` 原来写死 'off'）。
  const base = describerWith(rawJson());
  await base.describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(base.stream.calls[0].reasoningEffort, 'off', '默认（false）走的就是老路');
  assert.equal(base.describer.stats().stickerGate.enableThinking, false, '调试快照里也要能看见它');

  // true：**不发** `reasoningEffort`（不是发 'low' —— 手写模型只支持 'off'，发别的会
  // 直接抛 UNSUPPORTED_REASONING_EFFORT）。"不发"才是"让 provider 用默认档"。
  const on = describerWith(rawJson(), { gate: { enableThinking: true } });
  await on.describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal('reasoningEffort' in on.stream.calls[0], false, 'enableThinking=true ⇒ 不发这个字段');
  assert.equal(on.describer.stats().stickerGate.enableThinking, true);
});

test('★★ enableThinking 进了留样（侧车 json **和 index.jsonl** 都要能筛出来）', async () => {
  // ⚠️ 刻意放 `thresholds` 而不是 `notes`：`notes` 只进侧车 json，
  //    而 `thresholds` 同时进侧车 json **和 index.jsonl 那一行**（见 sticker-audit 的 appendIndex）。
  const saved = [];
  const describer = createImageDescriber({
    attachments: fakeAttachments(),
    stream: fakeStream(rawJson()),
    fetchImpl: okFetch,
    stickerGate: { enableThinking: true },
    stickerAudit: { save: async (input) => { saved.push(input); return null; }, stats: () => ({}) },
  });
  await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(saved.length, 1);
  assert.equal(
    saved[0].thresholds.enableThinking, true,
    '留样必须记下"这次关没关思考" —— 事后要能拿一行筛出整批的开关状态',
  );

  // 默认那份要是 false（别把默认值记成 undefined）
  const saved2 = [];
  const d2 = createImageDescriber({
    attachments: fakeAttachments(),
    stream: fakeStream(rawJson()),
    fetchImpl: okFetch,
    stickerAudit: { save: async (input) => { saved2.push(input); return null; }, stats: () => ({}) },
  });
  await d2.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(saved2[0].thresholds.enableThinking, false);
});

test('★ enableThinking 只管「认」那条路：转发图那句描述（describe）照旧 reasoningEffort=off', async () => {
  // 「认」开着思考不该把"转发里夹着的图"那句描述也带跑偏 —— 那是另一条路、另一种预算。
  const stream = fakeStream('一只橘猫趴在键盘上');
  const describer = createImageDescriber({
    attachments: fakeAttachments(), stream, fetchImpl: okFetch,
    stickerGate: { enableThinking: true },
  });
  await describer.describe({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(stream.calls[0].reasoningEffort, 'off', '描述那条路**没有**思考开关，永远是 off');
});

test('★★ 钉住"两个列表一一对应"：normalizeStickerGate 会夹的键 ⊂ loadStickerGate 的 warn 列表', async () => {
  // ⚠️ 这条测试是**防止同一个坑踩第三次**：
  //    `index.mjs` 的 `loadStickerGate` 里有一个**硬编码的键名列表**，逐个 warn"越界被夹紧"。
  //    它必须和 `normalizeStickerGate` 里会夹的那些键一一对应。
  //    2026-10-09 `funnyMin` 漏在里面 ⇒ 写越界**静默夹紧、日志里一个字都没有**。
  //
  // ⇒ 所以**不写死一份期望清单**（写死了就变成"照着测试写代码"），
  //   而是从**两边各自的真源**里动态取出来比：
  //     A = normalizeStickerGate 对一个"全部越界"的输入**确实改变了值**的那些键
  //     B = index.mjs 源码里那个列表
  const over = {};
  for (const [k, v] of Object.entries(DEFAULT_STICKER_GATE)) {
    if (typeof v === 'number') over[k] = v + 100000;   // 单向顶到上界就够（每个键都必然被夹）
    // ⭐ 2026-10-10：`enableThinking` 是**第一个布尔项** —— 它同样会被"夹紧"
    //    （不是布尔 ⇒ 回退默认值），所以这里也得让它越界，否则它会被下面的
    //    `stray` 反向检查当成"列表里多写了一个键"而误报。
    else if (typeof v === 'boolean') over[k] = 'not-a-boolean';
  }
  const clamped = normalizeStickerGate(over);
  const clampedKeys = Object.keys(over).filter((k) => clamped[k] !== over[k]);
  assert.ok(
    clampedKeys.length >= 6,
    `自检：这份"全部越界"的输入至少要夹住 6 个键，实际 ${clampedKeys.length} —— 说明取值方式坏了`,
  );

  const src = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const m = /for \(const key of \[([^\]]*)\]\)/.exec(src);
  assert.ok(m !== null, '没找到 loadStickerGate 里那个键名列表（它被改名/改形了？）');
  const listed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => s !== '');

  const missing = clampedKeys.filter((k) => !listed.includes(k));
  assert.deepEqual(
    missing, [],
    `⚠️ 这些键会被 normalizeStickerGate 夹紧，却没在 index.mjs 的 warn 列表里 ⇒ 写越界会**静默夹紧**：${missing.join(', ')}`,
  );
  // 反方向：列表里写了一个根本不会被夹的键 ⇒ warn 永远不会触发，也是坏的
  const stray = listed.filter((k) => !clampedKeys.includes(k));
  assert.deepEqual(stray, [], `⚠️ warn 列表里有键其实不会被夹（日志里永远不会出现它）：${stray.join(', ')}`);
});


// ------------------------------------------------------------------ 端到端：describeSticker

test('★★ describeSticker：一次调用出全部（JSON → 契约对象），且 provider 可被 gate 覆盖', async () => {
  const reply = rawJson({
    scores: { nsfw: 0, violence: 0, gore: 1, ugly: 2, funny: 8 },
    caption: '寿终正寝',
    desc: '黑白漫画，少女盖被闭眼安详躺着',
    tags: ['无语无奈'],
  });
  const { describer, stream, attachments } = describerWith(reply);
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png', name: 'a.png' });
  assert.equal(got.ok, true);
  assert.equal(got.accept, true);
  assert.deepEqual(got.scores, { nsfw: 0, violence: 0, gore: 1, ugly: 2, funny: 8 });
  assert.equal(got.caption, '寿终正寝');
  assert.equal(got.captionChars, 4);
  assert.equal(got.desc, '黑白漫画，少女盖被闭眼安详躺着');
  assert.deepEqual(got.tags, ['无语无奈']);
  assert.equal(got.reject, null);
  assert.equal(got.political, false);
  assert.equal(got.pureText, false);
  assert.equal(typeof got.phash, 'string', 'phash 一定在判定结果里（不是 undefined）');

  assert.equal(stream.calls.length, 1, '**一次**调用出全部（不是 describe + 打分两次）');
  assert.equal(attachments.saved.length, 1);
  const content = stream.calls[0].messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[1].type, 'text');
  assert.match(content[1].text, /只输出一个 JSON 对象/);
  assert.ok(content[1].text.includes('JOJO'), '发给模型的指令里带着配文判据');
  assert.match(stream.calls[0].system, /JSON/);
  assert.equal(stream.calls[0].reasoningEffort, 'off');
  assert.equal(stream.calls[0].provider, '', 'gate.provider 留空 ⇒ 不改 provider');
  assert.equal(describer.stats().stickerCalls, 1);
  assert.equal(describer.stats().stickerAccepted, 1);
  assert.equal(describer.stats().stickerRejected, 0);
  assert.equal(describer.canUseVision(), true);
});

test('★★ describeSticker：gate 的 provider/model 只对这一条审核调用生效', async () => {
  const { describer, stream } = describerWith(rawJson(), { gate: { provider: 'local-llamacpp', model: 'qwen3.5-4b-q4km' } });
  await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(stream.calls[0].provider, 'local-llamacpp');
  assert.equal(stream.calls[0].model, 'qwen3.5-4b-q4km');
  // 实例级的那份要能从 stats 里看到（"toml 到底生效没有"的直接证据）
  const g = describer.stats().stickerGate;
  assert.equal(g.provider, 'local-llamacpp');
  assert.equal(g.model, 'qwen3.5-4b-q4km');
  assert.equal(g.nsfwMax, 4);
  assert.equal(g.promptFromToml, false, '没给 prompt ⇒ 走代码兜底');
});

test('★★ describeSticker：模型说"没事"但分数过阈值 ⇒ 代码改判不收（不信模型自述）', async () => {
  const { describer } = describerWith(rawJson({ scores: { nsfw: 6, violence: 0, gore: 0, ugly: 0, funny: 8 } }));
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, true, '"认"成功了（拿到了判定）');
  assert.equal(got.accept, false, '但收不收由代码说了算');
  assert.equal(got.reject, 'nsfw');
  const s = describer.stats();
  assert.equal(s.stickerRejected, 1);
  assert.equal(s.stickerReasons.nsfw, 1, '按原因分开计 —— "哪条判据在拦"必须能直接看出来');
  assert.equal(s.stickerReasons.ugly, 0);
});

test('★★⭐ describeSticker：不够有趣 ⇒ 拒，计数进 `boring` 那一档（治误收的那条）', async () => {
  const { describer } = describerWith(rawJson({ desc: '一只黑白猫趴在湿润的小路上，抬头看镜头', scores: { ...ZERO_SCORES, funny: 1 } }));
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, true);
  assert.equal(got.accept, false);
  assert.equal(got.reject, 'boring');
  assert.equal(describer.stats().stickerReasons.boring, 1);
});

test('★ describeSticker：纯文字图 ⇒ 拒，计数进 `text` 那一档', async () => {
  const { describer } = describerWith(rawJson({ pureText: true, desc: '白底黑字的文档清单' }));
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.accept, false);
  assert.equal(got.reject, 'text');
  assert.equal(got.pureText, true);
  assert.equal(describer.stats().stickerReasons.text, 1);
});

test('★★ describeSticker：模型判"不是表情包" ⇒ 拒，计数进 not-sticker 那一档', async () => {
  const { describer } = describerWith(rawJson({ isSticker: false }));
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, true);
  assert.equal(got.isSticker, false);
  assert.equal(got.accept, false);
  assert.equal(got.reject, 'not-sticker');
  const s = describer.stats();
  assert.equal(s.stickerReasons['not-sticker'], 1, '哪条判据在拦必须能直接看出来');
  assert.equal(s.stickerAccepted, 0);
  assert.equal(s.stickerRejected, 1);
});

test('★ describeSticker：模型没给 isSticker ⇒ ok:false（不入库；下次它再出现会重认）', async () => {
  const noFlag = JSON.stringify({
    portrait: false, screenshot: false, scores: { ...ZERO_SCORES },
    caption: '', desc: '一只猫', tags: [], unmatched: '',
  });
  const { describer, stream } = describerWith(noFlag);
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, false, '未知不能当"不是表情包"');
  assert.equal(got.accept, false);
  assert.equal(stream.calls.length, 1, '不重试');
  assert.equal(describer.stats().stickerFailed, 1);
});

test('★ describeSticker：段里带 summary 也**必须看图**（"认"不能拿 QQ 的类型标签交差）', async () => {
  const { describer, stream } = describerWith(rawJson());
  const got = await describer.describeSticker({ summary: '[微笑]', sub_type: 7, url: 'https://x/s.jpg', file: 's.jpg' });
  assert.equal(got.desc, '一只猫');
  assert.equal(stream.calls.length, 1, 'summary 有值也不行 —— 它可能只是 QQ 的类型标签');
  assert.match(stream.calls[0].messages[0].content[1].text, /只输出一个 JSON 对象/);
});

test('★ describeSticker：多帧 GIF 走既有那条"挑关键帧拼一张"的路（不另造一套）', async () => {
  const attachments = fakeAttachments();
  const { describer, stream } = describerWith(rawJson({ desc: '两个画面在变', tags: ['玩梗接梗'] }), { attachments });
  // ⚠️ 夹具是 **base64 字符串**（`test/fixtures/gif-bytes.mjs`），不是原始字节。
  const bytes = new Uint8Array(Buffer.from(GIF_6FRAMES, 'base64'));
  const got = await describer.describeSticker({ data: bytes, mediaType: 'image/gif', name: 'x.gif' });
  assert.equal(got.ok, true);
  assert.equal(stream.calls.length, 1);
  assert.equal(describer.stats().sheets, 1, '真的拼了图（不是逐帧调好几次）');
  assert.match(stream.calls[0].messages[0].content[1].text, /个画面/);
  assert.equal(attachments.saved.length, 1);
  assert.equal(attachments.saved[0].mediaType, 'image/png', '喂给模型的是拼好的 PNG（同 image-desc 那条路）');
});

test('★★ describeSticker：任何一条失败路径都 **不抛**，而且一律 fail-closed', async () => {
  // ① 没有视觉服务
  const noVision = createImageDescriber({ attachments: null, stream: null, fetchImpl: okFetch });
  assert.equal(noVision.canUseVision(), false);
  const a = await noVision.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(a.ok, false);
  assert.equal(a.accept, false);
  assert.equal(noVision.stats().stickerFailed, 1);

  // ② 模型返回的是垃圾（不可解析）
  const { describer: garbage, stream: gs } = describerWith('我今天不想输出 JSON');
  const b = await garbage.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(b.ok, false);
  assert.equal(b.accept, false);
  assert.equal(gs.calls.length, 1);

  // ③ 模型调用抛错
  const throwingStream = () => { throw new Error('模型炸了'); };
  const c = await createImageDescriber({ attachments: fakeAttachments(), stream: throwingStream, fetchImpl: okFetch })
    .describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(c.ok, false);
  assert.equal(c.accept, false);

  // ④ 段取不到字节（下载失败）
  const failFetch = async () => ({ ok: false });
  const d = await createImageDescriber({ attachments: fakeAttachments(), stream: fakeStream('{}'), fetchImpl: failFetch })
    .describeSticker({ url: 'https://x/gone.jpg', file: 'gone.jpg' });
  assert.equal(d.ok, false);
  assert.equal(d.accept, false);

  // ⑤ 传进来的不是对象
  const { describer } = describerWith('{}');
  assert.equal((await describer.describeSticker(null)).ok, false);

  // ⑥ 解析出来了、但 scores 不完整
  const { describer: partial } = describerWith(JSON.stringify({ portrait: false, desc: '一只猫', tags: [] }));
  const e = await partial.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(e.ok, false, 'scores 缺项 = 没看成（不是"安全"）');
  assert.equal(e.accept, false);
});

test('★★ `ok:false` 的降级行为：**fail-closed 且不重试**（只调一次模型）', async () => {
  // 模型没给可解析的 JSON —— 重放同一个提示词大概率一模一样地坏，
  // 而且"没入库 ⇒ 下次它再出现时会重认"已经是天然重试（见模块注释）。
  const { describer, stream } = describerWith('模型今天不想说话');
  const got = await describer.describeSticker({ data: PNG_BYTES, mediaType: 'image/png' });
  assert.equal(got.ok, false);
  assert.equal(got.accept, false);
  assert.equal(stream.calls.length, 1, '**绝不重试**：一次"认"就是一次调用');
  assert.equal(describer.stats().stickerCalls, 1);
  assert.equal(describer.stats().stickerFailed, 1);
  // 用户关心的"重试一次"在这里由**库**兜着：不入库 ⇒ 下次出现再认一遍（见下面的接线测试）。
});

// ------------------------------------------------------------------ 与库的接线

/** 一个隔离的临时库（与 `sticker-library.test.mjs` 同构）。 */
function tempLib({ recognize, fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-recognize-'));
  const dir = path.join(root, 'stickers');
  const indexPath = path.join(root, 'qq-stickers.json');
  const logs = [];
  const bytes = PNG_BYTES;
  const seg = {
    type: 'image',
    sub_type: 1,
    summary: '',
    file: 'a.jpg',
    url: 'https://gchat.qpic.cn/x',
  };
  const library = createStickerLibrary({
    dir,
    indexPath,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    fetchImpl: fetchImpl ?? (async () => ({
      ok: true,
      async arrayBuffer() { return bytes.buffer.slice(0); },
    })),
    ...(recognize === undefined ? {} : { recognize }),
  });
  return { root, dir, indexPath, library, logs, seg, bytes };
}

/** 「认」成功且收下的一份返回值。 */
function accepted(over = {}) {
  return {
    ok: true,
    accept: true,
    reject: null,
    rejects: [],
    isSticker: true,
    portrait: false,
    screenshot: false,
    political: false,
    pureText: false,
    scores: { ...OK_SCORES },
    caption: '',
    captionChars: 0,
    desc: '一只猫',
    tags: ['卖萌可爱'],
    unmatched: '',
    phash: '',
    ...over,
  };
}

test('★★ 接线：`recognize` 说收 ⇒ 入库并把 tags 写进索引', async () => {
  const calls = [];
  const { library, indexPath, seg } = tempLib({
    recognize: async (image, meta) => { calls.push({ image, meta }); return accepted(); },
  });
  const got = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.equal(calls.length, 1, '每张新表情**一次**"认"');
  assert.ok(calls[0].image?.data instanceof Uint8Array, '"认"要拿到已经取好的字节（别再下载一次）');
  assert.equal(calls[0].meta?.chatId, 'g');
  const entries = JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries;
  const entry = Object.values(entries)[0];
  assert.deepEqual(entry.tags, ['卖萌可爱'], 'tags 接上了');
});

test('★★ 接线：`recognize` 说**不收** ⇒ 不入库（审核闸真的有效果）', async () => {
  const { library, dir, indexPath, seg, logs } = tempLib({
    recognize: async () => accepted({
      accept: false, reject: 'portrait', rejects: ['portrait'],
      portrait: true, desc: '真人自拍', tags: [],
    }),
  });
  const got = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(got.rejected, 1);
  assert.equal(got.stored, 0);
  assert.equal(got.auditFailed, 0, '"判了不收"与"没看成"必须分开计');
  assert.equal(fs.existsSync(dir), false, '被拒的图一个字节都不落盘');
  assert.equal(fs.existsSync(indexPath), false);
  assert.equal(library.stats().rejected, 1);
  // 日志里要能看见**原因与当时的分数**（用户靠这行调阈值）
  const rej = logs.find((l) => l.message.includes('没过审核闸'));
  assert.ok(rej !== undefined);
  assert.equal(rej.meta.reject, 'portrait');
  assert.deepEqual(rej.meta.scores, OK_SCORES, '各项打分都是"没问题"的也照样拒 —— 真人没有阈值');
});

test('★★ 接线：`recognize` 没看成（ok:false）⇒ 也不入库，单独计数', async () => {
  const { library, dir, seg } = tempLib({ recognize: async () => ({ ...failedStickerVerdict() }) });
  const got = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(got.auditFailed, 1);
  assert.equal(got.rejected, 0);
  assert.equal(got.stored, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(library.stats().auditFailed, 1);
});

test('★★ 接线：`ok:false` 的"天然重试"—— 下次它再出现时会**重认一遍**', async () => {
  const calls = [];
  const { library, seg } = tempLib({
    recognize: async () => { calls.push(1); return { ...failedStickerVerdict() }; },
  });
  const first = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(first.auditFailed, 1);
  const again = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(again.auditFailed, 1);
  assert.equal(calls.length, 2, '没入库 ⇒ md5 没写进索引 ⇒ 同一张图会再认一次（这就是"重试"）');
});

test('★ 接线：`recognize` 抛异常 → 当"没看成"（不入库，但绝不把偷搞崩）', async () => {
  const { library, seg } = tempLib({ recognize: async () => { throw new Error('视觉服务炸了'); } });
  const first = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(first.auditFailed, 1);
  assert.equal(first.stored, 0);
  const again = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(again.auditFailed, 1);
  assert.equal(library.stats().auditFailed, 2);
});

test('★ 接线：没配 `recognize`（无视觉服务的部署）⇒ 行为与上一批一致（入库、tags 空）', async () => {
  const { library, indexPath, seg } = tempLib();
  const got = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.equal(got.rejected, 0);
  assert.equal(got.auditFailed, 0);
  const entry = Object.values(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries)[0];
  assert.deepEqual(entry.tags, []);
});

test('★ 接线：同一张表情第二次出现是**去重**，不重复花钱"认"', async () => {
  const calls = [];
  const { library, seg } = tempLib({
    recognize: async () => { calls.push(1); return accepted(); },
  });
  await library.harvest([seg], { chatId: 'g', userId: 'u' });
  const second = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(second.dedup, 1);
  assert.equal(calls.length, 1, 'md5/emoji 去重发生在"认"之前 —— 同一张图只认一次');
});

test('★ 接线：只有 emoji_id（没有 sub_type）的商城表情同样会走"认"', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-recognize-'));
  const bytes = PNG_BYTES;
  const calls = [];
  const library = createStickerLibrary({
    dir: path.join(root, 's'),
    indexPath: path.join(root, 'i.json'),
    log: () => {},
    fetchImpl: async () => ({ ok: true, async arrayBuffer() { return bytes.buffer.slice(0); } }),
    recognize: async (image) => { calls.push(image); return accepted({ desc: '鸭子', tags: ['幽默搞笑'] }); },
  });
  const seg = {
    type: 'image',
    summary: '[动画表情]',
    file: '67-674cbcb1606d656525fb8615f2648198.gif',
    url: 'https://gxh.vip.qq.com/club/item/parcel/item/67/674cbcb1606d656525fb8615f2648198/raw300.gif',
    emoji_id: '674cbcb1606d656525fb8615f2648198',
    emoji_package_id: 240387,
  };
  const got = await library.harvest([seg], { chatId: 'g', userId: 'u' });
  assert.equal(got.stored, 1);
  assert.equal(calls.length, 1);
  assert.equal(library.get(md5Hex(bytes)).emojiId, '674cbcb1606d656525fb8615f2648198');
});
