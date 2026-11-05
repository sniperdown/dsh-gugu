/**
 * 出站 **Markdown 剥除**：`[7-3]` 的回归测试。
 *
 * ## 为什么这组测试要写厚
 *
 * QQ **不渲染** Markdown。模型默认按 Markdown 写，于是 `**粗体**`、`# 标题`、
 * 表格竖线在手机上**原样显示**，用户看到的是乱码。用户 2026-10-08 明确要求
 * 「把你文本里的 md 格式通通去掉」。
 *
 * 但"剥"这个动作天生有两种错法，而且都比不剥更糟：
 *
 * | 错法 | 后果 |
 * |---|---|
 * | **剥多了** | **静默改了内容** —— 用户永远不知道原话是什么（最糟） |
 * | 剥少了 | 留着 `**`，难看但**信息没丢** |
 *
 * ⇒ 所以下面同时钉三件事：
 *   1. **认不出的语法一个字不动**（宁可少剥）
 *   2. **剥完内容还在**（URL、代码、表格里的字）
 *   3. **纯文本逐字节不变**（没有 MD 时输出 == 输入）
 *
 * ## 反例清单（这些**故意不剥**，谁"顺手"加了规则就会红）
 *
 * `1. ` / `- ` / `· ` 列点（人格里明确要求的说话方式）· `\*` 转义 ·
 * `2 * 3 * 4`（乘号）· `__init__`（名字，不是粗体）· `issue # 12`（`#` 不在行首）·
 * `a | b`（没被竖线包住的正文）· `** 空 **`（内侧空白不是强调）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { stripMarkdown } from '../src/onebot/plain-text.mjs';
import { Gateway } from '../src/dsh/gateway.mjs';
import { Router, POLICY } from '../src/dsh/routing.mjs';
import { ProactiveEngine } from '../src/proactive/engine.mjs';

// ================================================================== 原则一：宁可少剥

test('★ 原则一：认不出的东西**一个字不动**（逐字节相等）', () => {
  const untouched = [
    // 纯文本
    '今天天气不错，要不要出去走走？（真的）',
    // 行尾空格 + 三个空行：这些是"格式"但**不是 Markdown**，不能顺手改掉
    '第一行  \n\n\n\n第二行   ',
    // 列点：人格里明确要求的说话方式，**不是** MD 语法
    '1. 第一条\n2. 第二条\n- 甲\n- 乙\n· 丙',
    // 乘法 / 间隔符（两侧有空格 ⇒ 不是强调）
    '2 * 3 * 4 = 24',
    '2*3*4 = 24',
    // dunder：`__init__` 是**名字**，不是粗体
    '调用 __init__ 方法',
    'Python 的 __main__ 和 __name__',
    // `#` 不在行首 ⇒ 不是标题
    'issue # 12 修好了',
    // 没被竖线包住的整行 ⇒ 不是表格
    'a | b 只是并排',
    // 内侧是空白 ⇒ 不是强调
    '这个 * 不是斜体 * 吧',
    '** 不是粗体 **',
    // 反斜杠转义：星号是**内容**
    '这是 \\*字面星号\\* 不是斜体',
    '价格是 \\` 符号',
    // 空 / 纯空白
    '',
    '   \n  \t ',
  ];
  for (const text of untouched) {
    assert.equal(stripMarkdown(text), text, `不该动：${JSON.stringify(text)}`);
  }
});

test('★ 原则二：剥完**内容还在**（链接 URL / 代码 / 表格里的字）', () => {
  // URL 里的 `__init__` 也得活着（强调规则不能先把它吃掉）
  assert.equal(stripMarkdown('[文档](https://x.com/__init__)'), '文档 https://x.com/__init__');
  // 代码块里的 `**` 是代码
  assert.equal(stripMarkdown('```python\nx = a ** b\n```'), 'x = a ** b');
  // 行内代码里的 `**` 是内容，**不该被当粗体**
  assert.equal(stripMarkdown('这个 `**不是粗体**` 对吧'), '这个 **不是粗体** 对吧');
  // 表格只去掉管子和分隔行，单元格文字一个不少
  assert.equal(
    stripMarkdown('| 列A | 列B |\n|---|---|\n| 1 | 2 |'),
    '列A  ·  列B\n1  ·  2',
  );
});

test('★ 列点必须保留：`1. ` / `- ` / `· `（谁顺手剥了它就红）', () => {
  assert.equal(stripMarkdown('1. 第一\n2. 第二'), '1. 第一\n2. 第二');
  assert.equal(stripMarkdown('- 甲\n- 乙'), '- 甲\n- 乙');
  assert.equal(stripMarkdown('· 丙'), '· 丙');
  // 列点里的粗体照样要剥，但列点本身不能动
  assert.equal(stripMarkdown('- **重点**：做完了'), '- 重点：做完了');
  assert.equal(stripMarkdown('1. **第一条**'), '1. 第一条');
});

// ================================================================== 纯文本逐字节不变

test('★ 没有 MD 时输出 == 输入（连行尾空格和三个空行都不动）', () => {
  const plain = '结论：可以。\n\n明天再说  \n\n\n\n就这样';
  assert.equal(stripMarkdown(plain), plain);
});

test('★ 但真剥掉过东西时，空行要收拾（这条钉住"整理"不是死代码）', () => {
  // `---` 是水平线，剥掉它会在中间留一堆空行 —— 那时候才压成两行
  assert.equal(stripMarkdown('a\n\n\n\n---\n\n\n\nb'), 'a\n\nb');
  // 同样的空行，没有 MD ⇒ 一行都不动
  assert.equal(stripMarkdown('a\n\n\n\nb'), 'a\n\n\n\nb');
});

// ================================================================== 乱码清单

test('★ QQ 上会显示成乱码的那些：逐条对上', () => {
  const cases = [
    ['# 一级标题', '一级标题'],
    ['## 二级标题', '二级标题'],
    ['**粗体**', '粗体'],
    ['*斜体*', '斜体'],
    ['`代码`', '代码'],
    ['> 引用一句话', '引用一句话'],
    ['~~删除线~~', '删除线'],
    ['| 列A | 列B |\n|---|---|', '列A  ·  列B'],
    ['[文字](https://x.com/a)', '文字 https://x.com/a'],
    ['![猫](https://x.com/cat.png)', '猫 https://x.com/cat.png'],
    ['---', ''],
    ['***又粗又斜***', '又粗又斜'],
  ];
  for (const [input, want] of cases) {
    assert.equal(stripMarkdown(input), want, input);
  }
});

// ================================================================== 边界

test('边界：围栏代码整块保留（含反引号与 `**`），围栏行消失', () => {
  assert.equal(
    stripMarkdown('看这段：\n```python\nx = a ** b\n`y`\n```\n完事'),
    '看这段：\nx = a ** b\n`y`\n完事',
  );
  // 缩进的围栏也要认
  assert.equal(stripMarkdown('前文\n  ```js\n  x=1\n  ```\n后文'), '前文\n  x=1\n后文');
  // 代码块里的空行**不受**"收尾压空行"影响（那是代码）
  assert.equal(stripMarkdown('```\na\n\n\n\nb\n```'), 'a\n\n\n\nb');
  // 落单的围栏：整行删掉，内容留着
  assert.equal(stripMarkdown('文字\n```js\n代码还在吗'), '文字\n代码还在吗');
});

test('边界：`\\*` 转义与中文标点旁的符号', () => {
  assert.equal(stripMarkdown('这是 \\*字面星号\\* 不是斜体'), '这是 \\*字面星号\\* 不是斜体');
  assert.equal(stripMarkdown('这个**重点**，对吧？'), '这个重点，对吧？');
  assert.equal(stripMarkdown('（**粗体**）'), '（粗体）');
  assert.equal(stripMarkdown('中文*强调*中文'), '中文强调中文');
});

test('边界：超长行照样剥干净（不靠"行短"这个假设）', () => {
  const body = '字'.repeat(300);
  assert.equal(stripMarkdown(`${body}**结尾粗体**`), `${body}结尾粗体`);
  assert.equal(stripMarkdown(`**开头粗体**${body}`), `开头粗体${body}`);
});

test('边界：双下划线 —— `__粗体__` 要剥，`__init__` 不动', () => {
  assert.equal(stripMarkdown('__粗体__ 这样'), '粗体 这样');
  assert.equal(stripMarkdown('__加粗的话__'), '加粗的话');
  assert.equal(stripMarkdown('__init__'), '__init__');
  assert.equal(stripMarkdown('__main__ 入口'), '__main__ 入口');
});

test('边界：多段落的空行保留（QQ 上段落要分得开）', () => {
  assert.equal(stripMarkdown('开头\n\n**重点**\n\n结尾'), '开头\n\n重点\n\n结尾');
});

test('边界：非字符串输入不炸（网关里永远是字符串，但这是个导出的纯函数）', () => {
  assert.equal(stripMarkdown(undefined), '');
  assert.equal(stripMarkdown(null), '');
  assert.equal(stripMarkdown(42), '42');
});

// ================================================================== 端到端：走 Gateway

/** 假传输层：记录 `sendToChat` 收到的**原始 message**（字符串还是段数组一眼可见）。 */
function makeTransport() {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    selfId: '999',
    sent,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async sendToChat(chatId, message) {
      sent.push({ chatId, message });
      return sent.length;
    },
  };
}

/** 装一套网关：真 Router/Engine + 假 transport/responder。 */
function harness({ reply = '回复' } = {}) {
  const transport = makeTransport();
  const router = new Router({
    dmPolicy: POLICY.OPEN,
    groupPolicy: POLICY.ALLOWLIST,
    groupAllowFrom: ['200000001'],
    requireMention: true,
    botQQ: '999',
  });
  const engine = new ProactiveEngine({
    config: { enabled: false, minIntervalMs: 0, maxPerHour: 10, cooldownAfterBotMs: 0, afterUserMsgCount: 0 },
    gauge: async () => ({ speak: true }),
    speak: async () => undefined,
    log: () => {},
  });
  const gateway = new Gateway({
    transport,
    router,
    engine,
    responder: async () => reply,
    log: () => {},
  });
  gateway.attach();
  return { gateway, transport };
}

/** 一条私聊入站消息（`runTurn` 用的最小形状）。 */
function privateMessage(text = '在吗') {
  return {
    chatId: 'private:10000001',
    kind: 'private',
    userId: '10000001',
    nickname: '用户',
    text,
    at: Date.now(),
    mentioned: true,
    replyToSelf: false,
    segments: [{ type: 'text', text }],
    raw: text,
  };
}

test('★ 端到端：带 MD 的**回复**发出去时已经是剥完的', async () => {
  const h = harness({ reply: '## 结论\n**可以**，见 [文档](https://x.com/a)\n\n1. 甲\n2. 乙' });
  await h.gateway.runTurn({
    message: privateMessage(),
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
  });
  assert.equal(h.transport.sent.length, 1);
  assert.equal(
    h.transport.sent[0].message,
    '结论\n可以，见 文档 https://x.com/a\n\n1. 甲\n2. 乙',
    '发到 QQ 的必须是剥完的纯文本，而且**列点还在**',
  );
});

test('★ 端到端：纯文本回复仍然逐字节不变（老行为没被动过）', async () => {
  const h = harness({ reply: '在的，你说' });
  await h.gateway.runTurn({
    message: privateMessage(),
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
  });
  assert.equal(h.transport.sent[0].message, '在的，你说');
});

test('★ 端到端：主动发言也剥（`speakProactively` 是另一个调用点）', async () => {
  const h = harness();
  const ok = await h.gateway.speakProactively('group:200000001', '**提醒**：该睡了\n- 别熬夜');
  assert.equal(ok, true);
  assert.equal(h.transport.sent[0].message, '提醒：该睡了\n- 别熬夜');
});

test('★ 端到端：**图片段一个字节都不碰**，只剥文本段', async () => {
  const h = harness();
  const url = 'https://gxh.vip.qq.com/club/item/parcel/item/67/aaa/raw300.gif';
  const ok = await h.gateway.speakProactively('group:200000001', '# 看图 **这个**', [url]);
  assert.equal(ok, true);
  assert.deepEqual(h.transport.sent[0].message, [
    { type: 'text', text: '看图 这个' },
    { type: 'image', data: { url } },
  ]);
});

test('★ 端到端：空回复 + 有图 ⇒ 只发图（剥除不该把"只发表情包"吃掉）', async () => {
  const h = harness({ reply: '' });
  await h.gateway.runTurn({
    message: privateMessage('x'),
    sessionKey: 'qq-private-10000001',
    restricted: false,
    prompt: 'p',
    addressed: true,
    images: ['http://x/a.png'],
  });
  assert.deepEqual(h.transport.sent[0].message, [{ type: 'image', data: { url: 'http://x/a.png' } }]);
});
