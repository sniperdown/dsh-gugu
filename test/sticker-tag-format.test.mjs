/**
 * `tags` 的**格式契约**：模型回的是"数组里每项一个枚举值"，不是"斜杠拼成一串"。
 *
 * ## 这个文件为什么存在（2026-10-09 的实测事故）
 *
 * `buildStickerInstruction()` 原来把 17 个枚举用 `/` 拼进 `{tags}` 占位符
 * （`STICKER_TAGS.join('/')`）。批量喂本地 4B 时实测（20 张，
 * `shared/tmp/2026-10-09-批量喂本地图-session-00000000.md`）：
 *
 * ```json
 * {"tags":["调侃吐槽/幽默搞笑/无语无奈"]}     ← 模型照抄了分隔符的形状
 * ```
 *
 * 一个数组元素里塞了三个枚举值，而 {@link normalizeStickerTags} **只认精确枚举值**
 * （那是它的契约，见 `sticker-tags.mjs` 的注释：近似匹配会让"模型没选出来"被悄悄掩盖）
 * ⇒ 整条进 `unmatched`、**标签全丢**。20 张里 3 张这样，而且
 * **16 张只拿到 1 个标签、0 张拿到 2–3 个** —— 说明那个斜杠列表被模型当成了
 * "标签的写法"，不是"可选项的清单"。
 *
 * ## 修在哪一层（这是本文件要钉死的那条决策）
 *
 * **修上游（提示词 + 分隔符），不修下游（不去拆斜杠）。**
 * 拆斜杠要猜"哪些斜杠是分隔符" —— 枚举值里没有斜杠，但 `unmatched` 里可能有，
 * 那是往判定链路里塞一个"看起来像修好了"的模糊层。所以：
 *
 * 1. 分隔符改成 `「调侃吐槽」、「幽默搞笑」…`（每个值单独括起来）——
 *    见 `buildStickerInstruction`；
 * 2. 提示词里把**数组格式写死**（含"对/错"两组例子）——
 *    代码兜底（`DEFAULT_STICKER_PROMPT`）与**真 toml**（`[sticker_gate] prompt`）
 *    **两处一起改**，因为模型读的是 toml 那份。
 *
 * ⚠️ 别再退回 `join('/')`：`normalizeStickerTags` 的行为**故意不动**，
 * 所以一旦分隔符又变成"看起来像值的一部分"，标签会**静默**丢光
 * （不报错、`ok:true`、只是 `tags` 是空的 —— 正是这个项目最贵的一类坑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DEFAULT_STICKER_PROMPT, buildStickerInstruction } from '../src/dsh/image-desc.mjs';
import { STICKER_TAGS, normalizeStickerTags } from '../src/dsh/sticker-tags.mjs';
import { parseToml } from '../src/dsh/toml.mjs';
import { resolveModelToml } from '../src/dsh/toml-files.mjs';

/**
 * 真 toml（模型实际读的那份）。
 *
 * ⚠️ 2026-10-30：`[sticker_gate]` 已从主文件拆到 `qq-gugu.sticker.toml`。
 * 这里**不能**再直接读主文件 —— 那会读到"空的 prompt"，看起来像提示词丢了。
 * 用解析器问"这一刻加载器会读哪份"，和加载器走同一条路。
 */
// ⚠️ 这是**集成用例**：它钉"部署里那份 toml 的提示词与代码兜底是否一致"。
// 公开仓库里没有部署配置，所以默认跳过；要看它跑，设 `QQ_GUGU_TOML=<你自己的 qq-gugu.toml>`。
const MAIN_TOML = process.env.QQ_GUGU_TOML ?? '';
const REAL_TOML = MAIN_TOML === '' ? '' : resolveModelToml(MAIN_TOML, 'sticker').path;

/** 把提示词切成行，便于"只在【tags】那一段里断言"。 */
const linesOf = (text) => String(text).split('\n');

/** 提示词里**讲可选列表**的那一行（`{tags}` 占位符所在那行）。 */
const tagListLineOf = (text) => linesOf(text).find((l) => l.includes('只能从这个列表里选')) ?? '';

test('★ {tags} 占位符填进去的是「」括起来的清单，**不是斜杠拼一串**', () => {
  const p = buildStickerInstruction();
  const line = tagListLineOf(p);
  assert.notEqual(line, '', '提示词里必须还有"只能从这个列表里选"那一段');
  // 每个枚举都得在，而且**单独被括起来**（这是"它是一个值"的视觉信号）
  for (const tag of STICKER_TAGS) {
    assert.ok(line.includes(`「${tag}」`), `枚举值「${tag}」没有以「」形式出现在可选列表里`);
  }
  assert.equal(line.includes(STICKER_TAGS.join('/')), false, '⚠️ 不许再用 `/` 把枚举拼成一串（实测模型会照抄成一个标签）');
  for (let i = 0; i < STICKER_TAGS.length - 1; i += 1) {
    assert.equal(
      line.includes(`${STICKER_TAGS[i]}/${STICKER_TAGS[i + 1]}`),
      false,
      `相邻枚举「${STICKER_TAGS[i]}/${STICKER_TAGS[i + 1]}」被拼在了一起`,
    );
  }
  assert.ok(line.includes('、'), '分隔符用顿号（每个值都是独立的一项）');
});

test('★ 提示词把**数组格式**写死了：对/错两组例子 + "每个元素只放一个"', () => {
  const p = buildStickerInstruction();
  assert.match(p, /tags 是\*\*数组\*\*/, '要明说 tags 是数组');
  assert.match(p, /每个元素只放一个/, '要明说每个元素只放一个枚举值');
  assert.ok(
    p.includes('["调侃吐槽","幽默搞笑","无语无奈"]'),
    '缺"对"的例子（三个元素）—— 模型需要一个可照抄的正确形状',
  );
  assert.ok(
    p.includes('["调侃吐槽/幽默搞笑/无语无奈"]'),
    '缺"错"的例子（斜杠挤成一个元素）—— 实测就是这个形状，要点名它',
  );
  assert.ok(p.includes('对：') && p.includes('错：'), '两组例子要各自成组（和 caption / isSticker 那两段同一个写法）');
});

test('★★ 真 toml 的提示词也带着这条格式规则（模型读的是 toml 那份）', {
  skip: fs.existsSync(REAL_TOML) ? undefined : `没找到 ${REAL_TOML}`,
}, () => {
  const parsed = parseToml(fs.readFileSync(REAL_TOML, 'utf8'));
  const p = String(parsed?.sticker_gate?.prompt ?? '');
  assert.notEqual(p, '', '真 toml 的 [sticker_gate] prompt 不该是空的');
  assert.match(p, /tags 是\*\*数组\*\*/, '真 toml 里缺"tags 是数组"这句');
  assert.match(p, /每个元素只放一个/, '真 toml 里缺"每个元素只放一个"这句');
  assert.ok(p.includes('["调侃吐槽/幽默搞笑/无语无奈"]'), '真 toml 里缺"错"的例子');
  // 占位符还在（提示词是模板，运行期才填）
  assert.ok(p.includes('{tags}'), '真 toml 的那段必须保留 {tags} 占位符');
});

test('★★ 下游**故意不补**：斜杠串仍然当"没选出来"（修上游的证据）', () => {
  // 这条钉的是一个**决策**，不是"现在的实现恰好如此"：
  // 拆斜杠要猜"哪些斜杠是分隔符"，会把"模型没按格式回"这件事掩盖掉。
  const bad = normalizeStickerTags(['调侃吐槽/幽默搞笑/无语无奈']);
  assert.deepEqual(bad.tags, [], '斜杠串不该被拆成三个标签（那样等于补下游、引入歧义）');
  assert.equal(bad.unmatched, '调侃吐槽/幽默搞');

  // 而**正确格式**必须一个不漏地收下
  const good = normalizeStickerTags(['调侃吐槽', '幽默搞笑', '无语无奈']);
  assert.deepEqual(good.tags, ['调侃吐槽', '幽默搞笑', '无语无奈']);
  assert.equal(good.unmatched, '');
});

test('★ 分隔符改了之后，{tags} 仍然只被填一次、别的占位符不受影响', () => {
  const p = buildStickerInstruction();
  assert.doesNotMatch(p, /\{(?:intro|descChars|tags|banned)\}/, '不该留任何没填的占位符');
  assert.ok(DEFAULT_STICKER_PROMPT.includes('{tags}'), '代码兜底是**模板**（占位符还在，填完才发给模型）');
  // 自定义提示词（toml 给的那种）也要吃到同一份填法
  const custom = buildStickerInstruction({ gate: { prompt: 'T:{tags}' } });
  assert.ok(custom.includes(`「${STICKER_TAGS[0]}」`), '自定义提示词里的 {tags} 也要用「」清单填');
  assert.ok(custom.includes(`「${STICKER_TAGS[16]}」`), '最后一个枚举值也要在');
  assert.equal(custom.includes(STICKER_TAGS.join('/')), false);
});
