/**
 * 图片 → **一句简短描述**。
 *
 * ## 为什么要单独一个模块
 *
 * 两个地方要的是同一件东西，所以只实现一次：
 *
 * 1. **入站富文本**：合并转发里夹着的图，模型现在只看到 `[图片1 745KB]` 这种
 *    元信息（`onebot/rich.mjs`），得知道"里面是什么"才谈得上"看得见"。
 * 2. **偷表情包**（下一步）：用户要求「图片用描述，可以和偷表情包的那套简短描述
 *    公用」—— 表情包要存下来，就得有个短标签当索引。
 *
 * 所以对外只有一个动作：**给一张图，还一句话**。
 *
 * ```js
 * const desc = createImageDescriber({ attachments, stream, provider, model });
 * const one = await describer.describe(imageSegment);                  // → '一只橘猫趴在键盘上'（默认 50 字上下）
 * const tag = await describer.describe(stickerSegment, { maxChars: 12 }); // → '柴犬歪头'（表情包：短）
 * ```
 *
 * ## 2026-10-07：这一层要"**诚实**"，而且要看得出"动"
 *
 * 用户提了两件事（都来自小鲸鱼的实测）：
 *
 * ### ① 描述不许编它看不出的事
 *
 * 有一条描述写的是「**动画表情**」。**单看一张静帧，判断不了它是不是在动** ——
 * 写出来就是编。所以提示词里**明确禁掉**这几个词：
 * **动画 / 动图 / 视频 / 会动 / 循环**（外加 `GIF`、`动态图`）。
 * 剩下的只描述画面里有的：颜色、人物、表情、文字、构图。**看不出就不说。**
 *
 * ⚠️ **但这是"提示词"，提示词是软约束** —— 这个项目反复栽在"提示词里写了、
 * 模型当没听见"上（长度硬截就是这么来的）。所以代码里还有一道
 * {@link findJudgementWording} 兜底：真检出这类词就**整条丢掉**（返回 `''`，
 * 调用方退回占位符），并把原文记进日志。
 *
 * **为什么宁可丢掉整条**：描述是**唯一能穿越长上下文的载体**（图片会被 offload，
 * 描述不会，小鲸鱼实测）—— 也就是说编出来的那句话会**永久留在历史里**，
 * 而且事后**没法回头核对**（原图早就不在了）。所以"可能是编的"比"没有描述"更糟，
 * 退回 `[图片1 745KB]` 反而是诚实的。
 *
 * ⚠️ **代码里的判定比提示词更窄**（只杀"给这张图下结论"的说法，
 * 不杀 `循环`、`视频` 这两个**可能真的是画面内容**的词 ——
 * "循环箭头图标"和"图上印着『视频』二字"都是真实存在的画面）。
 * 提示词宽一点是引导，代码杀得太宽就是误伤真话。
 *
 * ### ② 上游还有个**同名的坑**：QQ 自己给的 `summary` 也在说"动画表情"
 *
 * 实测（2026-10-07，`get_friend_msg_history` 捞 136 张图）：
 *
 * ```
 * summary 取值分布：  ""(108)   "[动画表情]"(27)   "[？]"(1)
 * ```
 *
 * **QQ 自己就把 `summary` 写成 `[动画表情]`**（全部是 `sub_type: 1`，而且**全是 `.jpg`**）。
 * 也就是说：小鲸鱼看到的那句「动画表情」**极可能根本不是模型编的，是 QQ 的标签原样透传**。
 * ⇒ 只改提示词**治不了**这一条。现在把这类"**给图片下结论的标签**"
 * 和 `[？]` 一样当成"**不是描述**"（见 {@link isAnimationClaimLabel}），
 * 落到视觉那一级去描述**画面**。
 *
 * ### ③ 多帧 GIF：真的去看"从哪变到哪"
 *
 * DSH 会把动图归一化成**单帧 webp**（`dsh-llm` 投影那一步），所以模型端永远只看得到一帧。
 * 小鲸鱼实测：48 帧的 GIF，**第 47 帧才是笑点**，它拿到的是「眼眶含泪」那一帧。
 *
 * 现在这条链路是：
 *
 * ```
 * 段里的 file
 *   ↓  ① 本地按名字找原件（零网络；目录模板与账号都来自配置）
 *   ↓     找不到 → ② 下载原件（url；NapCat 的 &amp; 要反转义）
 * 算哈希（原件）→ ③ 查跨会话缓存表 → 命中即用（**连模型都不调**）
 *   ↓ 没命中
 *   ↓ ④ 是 GIF 且**帧数 > 1** → 按差异挑关键帧 → 横着拼成一张
 *   ↓ ⑤ 识图（拼图 = 一次调用看完"从哪变到哪"；单帧 = 原样）
 * 生成描述 → ⑥ 写表（插件常驻，写盘；重启后还在）
 * ```
 *
 * 抽帧/解码/拼图都在 `dsh/gif.mjs`（零依赖，自己解 GIF）；本地查找与表在
 * `dsh/image-cache.mjs`。这里只负责把这些接起来。
 *
 * ## 2026-10-08：「认」——**一次调用出全部**（JSON），同日晚改成**打分制**
 *
 * 偷进来的表情包要能"记住它是什么"，所以同一次视觉调用顺便出全部字段：
 *
 * ```json
 * {"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,
 *  "scores":{"nsfw":0,"violence":0,"gore":0,"ugly":0,"funny":0},
 *  "caption":"我裂开了","desc":"约20字","tags":["枚举1-3个"],"unmatched":""}
 * ```
 *
 * ## ⭐ 2026-10-09：判据重写（依据 `shared\tmp\2026-10-09-联络表抽样复核-session-00000000.md`）
 *
 * 2197 张全量审核的实测：**误收 40%**（收下的 1126 张里约 450 张是脏图）、
 * **误杀 17.5%**（被拒的 1070 张里约 187 张其实该收），而且**四项打分几乎没用**
 * （2197 张里只有 41 张任一项 > 0 = 1.9%；分数只有 0 和 8-10 两种值，
 * 中间 1-7 分整批只出现 4 次 ⇒ **模型不会用连续量表，只会做"有/没有"**）。
 * ⇒ 光调阈值救不了，改的是**判据本身**：
 *
 * - ⭐ **新增 `funny`（有趣，0-10）** —— 用户原话「你会发现现在**没有任何一项是评价这张图
 *   是否有趣**」。原来那几项**全是负面筛选**（"没毛病就收"⇒ 必然宽松：一张随手拍的猫、
 *   一张新闻截图确实没毛病）⇒ 加上它，逻辑才变成"**不够有趣就不收**"。见 {@link STICKER_SCORE_KEYS}；
 * - ⭐ **新增 `political`（涉政）**：用户拍板「**涉政直接拒，不细分、不打分、不看阈值**」，
 *   提示词里明确写了「**爱国、爱党的正常表达不算涉政**」。命中即拒（原因 `political`）；
 * - ⭐ **新增 `pureText`（纯文字图）**：`text` 这条判据原来是「配文 > 5 字」，
 *   实测是**误杀的 100% 来源**（14/14），而"带字"恰恰是表情包主力 ⇒
 *   改成判「**是不是纯文字图**」（白底黑字、整张只有字、没有画面主体）；
 *   `captionMaxChars` 从 5 提到 **60**，降级成"长到不可能是表情包"的兜底红线；
 * - ⭐ **`ugly` 收窄**：原来的定义里有「**扭曲变形**」，而实测被它误杀的两张
 *   （猫弓起背身体扭成奇怪形状、一张脸表情扭曲）**是梗图的笑点、不是缺陷**
 *   ⇒ 现在 `ugly` **只管字面意义的脏丑**，"内容夸张/扭曲"改由 `funny` 给高分；
 * - ⭐ **`screenshot` 收窄**：手机**状态栏**、**拍摄设备水印**（`vivo X100 Pro` 这类）、
 *   **翻拍屏幕**（摩尔纹 / 反光 / 屏幕边框）算截图 ⇒ 拒；
 *   而**平台水印**（贴吧 / 抖音 / B站）**不算** —— 用户原话：「张维为的表情包是故意糊了
 *   中国人口吧的表情包的」⇒ 平台水印可能是**表情包本身的一部分**；
 * - ⭐ **`isSticker` 的示范例重写**：原来 `true` 那侧拿「**一只猫歪头看镜头**」当例子，
 *   等于**明文教模型把真猫照片算表情包**，而真猫狗实拍正是误收最大的一类（9/80）
 *   ⇒ `true` 侧换成动漫角色配字 / 熊猫头梗图 / 纯文字梗图，`false` 侧补齐四类反例
 *   （真实动物随手拍 / 游戏画面 / QQ 聊天截图 / 手办实拍）；
 *   ⚠️ 同时写清**"真实动物的照片也可以是表情包"**（狗张嘴咆哮、白猫瞪眼吐舌头那些），
 *   区别在**表情/姿态有没有戏、有没有配字**，不是"拍的还是画的"；
 * - 🔴 **2026-10-10 `isSticker` 那一段【部分回退】（C → B）**（用户拍板「isSticker 回退」）：
 *   全量 2221 张跑完后，澄清版（C）把闸门**改松了** —— not-sticker 164 → 406（更会判"不是"），
 *   但 `boring` 同时降 121，**净多收 61 张**，抽样多是真人照 / 代码截图 / 文件列表截图 /
 *   主板实物照 / 动漫整幅插画（**全该拒**）。用户原则是「**宁缺毋滥**」，方向相反 ⇒ 回退。
 *   **三版别搞混**：
 *   · **A** = 判据重写**之前**（示范例里有「一只猫歪头看镜头」）← **不退回这里**；
 *   · **B** = 判据重写**之后**（无猫 + 4 类反例：真动物随手拍 / 游戏截图 / QQ 聊天截图 / 手办实拍）
 *     ← ✅ **退到这里**（现状）；
 *   · **C** = 三段澄清版（在 B 之上加了"别人会不会把这张图当表情包发到群里"）← 回退掉它。
 *   ⇒ 判据句回到「**它判的是「这图能不能当表情包用」，跟好不好看、干不干净无关**」，
 *   `true` 侧是动漫角色抱头 / 熊猫头梗图 / 纯文字梗图（**没有**「一只猫歪头看镜头」），
 *   `false` 侧回到上面那 6 条（含真实动物随手拍 / 游戏截图 / QQ 聊天截图 / 手办玩偶实拍）。
 *   ⚠️ **后半段（"真实动物的照片也可以是表情包" + 狗张嘴咆哮·猫趴路边那对正反例 +
 *   判断方法 + 一句话口径）一个字都没动** —— 那是用户明确拍板过的内容。
 *   `screenshot` / `pureText` 两段**保留 C**（收益是实的、代价小）。
 *   详见 `shared/tmp/2026-10-10-isSticker回退-session-00000000.md`；
 * - ⭐ **新增感知哈希（{@link perceptualHashHex}）**：纯计算层，**不调模型**。
 *   ⚠️ 覆盖有限（插件零依赖，只有 GIF 解得了），见那个函数的说明。
 *
 * ### 契约细节
 *
 * - **只调一次模型**（不是"先描述、再打标签"两次）；
 * - ⭐ **`safe` 布尔已经删掉**（用户 2026-10-08 拍板"选 A"）：模型只给 `scores`
 *   各项 0-10 的**打分**，"收不收"由**代码**拿分数和阈值比
 *   （{@link sanitizeStickerVerdict}）—— 阈值在 `[sticker_gate]` 里。
 *   用户原话：「**不知道模型本身倾向，所以只能自己测试调整**」⇒
 *   阈值必须是配置项，不能是代码常数；
 * - ⭐ **`caption` 是"配文"而不是"图上所有字"**（用户 2026-10-08 点名修正）：
 *   帽子上的 `JOJO`、衣服上的 `ADIDAS` **不算**，表情包底部那行字**算**。
 *   这是个**语义判断**，数不出来，所以提示词里给了正反两组例子
 *   （见 {@link DEFAULT_STICKER_PROMPT}）；
 * - ⭐ **`isSticker`（这张图本身是不是表情包）也没有阈值**：`false` ⇒ 拒（原因 `not-sticker`）；
 *   缺失/非布尔 ⇒ `ok:false`（fail-closed，和 `scores` 同一条规矩：**未知不能当"不是"**）。
 *   为什么补它（2026-10-09）：一张风景照 `portrait=false` / `screenshot=false` /
 *   各项全 0 / 没有配文 ⇒ 上面那些判据**全部通过**、直接被收进表情包库。
 *   平时看不出来，是因为判据层 `stickerEvidence` 先在消息段上筛过一遍；
 *   而**批量喂本地图**（没有消息段的 `sub_type`）会绕开那一层 ⇒ 不补这条就是往库里灌风景照。
 * - **`portrait`（真人照片）/ `screenshot`（截图/翻拍/设备水印）/ `political`（涉政）/
 *   `pureText`（纯文字图）没有阈值**：命中即拒（红线）；
 * - **提示词在 toml 里**（`[sticker_gate] prompt`），不在代码里 ——
 *   代码里的 {@link DEFAULT_STICKER_PROMPT} 只是"toml 没写/读不到"时的兜底，
 *   内容和 toml 里那份**逐字相同**（生成脚本保证的，不是靠人抄）；
 * - `desc` 目标 **约 20 字**（{@link STICKER_DESC_CHARS}）；`tags` 只能取 17 个封闭枚举
 *   （`sticker-tags.mjs`），想用而用不上的词进 `unmatched`（**只记日志、不建桶**）；
 * - 既有的两道护栏（{@link findJudgementWording} / {@link isAnimationClaimLabel}）
 *   **搬到了 `desc` 与 `caption` 上**：模型说"动画表情"这类它无从判断的话，那一项丢掉；
 * - **没看成**（没有视觉服务 / 取不到字节 / 不是 JSON / `scores` 不是五个 0-10 /
 *   `isSticker`、`political`、`pureText` 里有不是布尔的）⇒ `ok:false` + `accept:false`
 *   （{@link STICKER_VERDICT_FAILED}，**fail-closed**）—— 调用方**不许**把它当"可以收"。
 *
 * ### ⚠️ `ok:false` 为什么**不重试**
 *
 * 1. **重放同一个提示词，大概率一模一样地坏**：判定型调用是尽量确定性的
 *    （`_qq-judge/COMPARISON.md` 的实测结论正是"有效的办法是**改问法**，不是重放"：
 *    同一个 4B，只把问法问干净就从 66% → 84%）；
 * 2. **这条路上已经有天然重试**：`sticker-library.mjs` 的 `audit-failed`
 *    **不入库、不写索引** ⇒ 同一张图**下次出现时会重来一遍**（间隔更长、代价为零）；
 * 3. 这是 fire-and-forget 路径：再花一次视觉调用，换来"这次还是没看成"，期望收益≈0。
 *
 * ⇒ 所以 `ok:false` 一律 fail-closed、**不重试**；想提成功率就改提示词（它在 toml 里）。
 *
 * ### ⚠️ 谁来做这一次调用（provider）
 *
 * 审核的**每一条判据都要看像素**，所以它只能由一个**有视觉能力的模型**执行。
 * `[sticker_gate]` 的 `provider` / `model` 留空 ⇒ **交给 `visionGate` 自动选**（本地/云，按空闲显存）；
 * 写了就**只对这一条审核调用**生效（`callVision` 的两个覆盖参数），**门控不插手 —— 手动赢**。
 *
 * ⚠️ **2026-10-09 更正**：这里原来写的是「留空 = 沿用 `imageDescriber` 那条**云**视觉路径」。
 * 那句话在**显存门控（`vision_gate`）加进来之前**是对的；门控落地后语义变了
 * —— `resolveRoles()` 里 `hasOverride === false` ⇒ **照常走门控**，
 * 所以"留空"现在等于**让门控接管**，不是"固定走云"。
 * ⚠️ **2026-10-10 更正这句"三处注释都改过了"**：它当时数是
 * ①本段 ②`DEFAULT_STICKER_GATE` 那段 ③`qq-gugu.toml` 里的同一句话 ——
 * 而 **③ 已经不再这么写了**（`[sticker_gate]` 现在**显式**写了 `provider`/`model`，
 * 那句话改成了"写了 = 手动赢"）⇒ 现在**前两处（都在本文件）一致**，
 * **别再去 toml 里找这句"留空"的说法**，那里已经不需要它了。
 * （这正是 AGENTS.md 那条「注释写得越像文档，越容易让人相信一个已经死掉的东西还活着」。）
 *
 * ## 两级取词（先便宜后花钱）
 *
 * | 级别 | 来源 | 代价 |
 * |---|---|---|
 * | **① `summary`** | **QQ 自己给的文本**（⚠️ 但"动画表情"这类**不算**） | **零** |
 * | **② 缓存表** | 内容哈希命中（跨会话） | **零**（只需拿到原件） |
 * | **③ 视觉模型** | 原件（多帧 GIF 就拼一张）→ 让多模态模型看一眼，只让它回一句 | 一次调用 |
 *
 * ## 四条硬约束
 *
 * 1. **绝不抛异常**：拿不到描述就返回 `''`，调用方退回占位符。
 *    一条图描述不出来，不能让整条消息跟着丢。
 * 2. **长度是"目标 + 余量"，不是一道死线**：默认目标 50 字，硬截上限是目标的 1.5 倍（→ 75）。
 *    ⚠️ 提示词里"简短"是**软约束**，模型经常当没看见 —— 所以代码里仍然硬截兜底。
 * 3. **长度可传参**：表情包要"**简短**"（十几个字），图片要"50 字上下"，两者共用这一个描述器。
 * 4. **内容是**不可信**的**（来自群友的图）：它只当**资料**投影，永远不进判定层、也不当指令用。
 *    渲染时一律包在 `[图片: …]` 里做结构化呈现。
 *
 * @module qq-gugu/image-desc
 */

import { fetchImageBytes, sniffImageMediaType, sourceFormatOf, MAX_IMAGE_BYTES } from './media.mjs';
import { DEFAULT_SHEET_FRAMES, buildGifSheet, decodeGifFrames, isGif, parseGifInfo } from './gif.mjs';
// 「认」那一步的标签是**封闭枚举**：选不出来的词只记日志、不建桶（见 `sticker-tags.mjs`）。
import { MAX_UNMATCHED_CHARS, STICKER_TAGS, normalizeStickerTags } from './sticker-tags.mjs';
// 显存门控（2026-10-09）：**只在真正要发视觉请求时**才问它这次走本地还是走云。
// ⚠️ 刻意**不** import 探针之外的东西：这一层只拿到一个"决策函数",
//    探针/缓存/阈值都在 `vram-gate.mjs` 里（那样它能被单独测，不用真显卡）。
import { DEFAULT_VISION_GATE, normalizeVisionGate } from './vram-gate.mjs';
import {
  DEFAULT_DESC_TABLE_PATH,
  DEFAULT_ORIGINAL_DIRS,
  contentHashNameOf,
  createDescTable,
  createOriginalFinder,
  md5Hex,
  sha256Hex,
} from './image-cache.mjs';

/**
 * 一句描述的**目标**字数（按码点算）。
 *
 * ⚠️ **2026-10-07 从 20 提到 50**，用户原话：
 * 「图片的描述**几个字可不行**，建议 **50 字上下**」。
 *
 * ⚠️ 注意这是**目标**不是**上限** —— 真正的硬截上限是
 * {@link descHardLimit}（= 这里 × {@link DESC_HARD_LIMIT_RATIO}，默认 50 → **75**）。
 * 分开的理由：用户说的是"50 字**上下**"，把上限卡死在 50 会把 55 字的正常描述砍掉。
 */
export const DEFAULT_MAX_DESC_CHARS = 50;

/**
 * 硬截上限相对目标字数的余量倍数。
 *
 * **为什么要有余量**：目标 50 是给模型看的"写多长"，而"上下"意味着 40~60 都算合格。
 * 若把硬上限也卡在 50，一句 55 字的好描述会被**无声地**砍成半截 —— 那比写短更糟
 * （信息丢了，而且看不出来丢过）。1.5 倍 → 目标 50 时上限 75；
 * 目标 12 时上限 18，表情包那种短标签也不会被砍。
 */
export const DESC_HARD_LIMIT_RATIO = 1.5;

/**
 * **提示词里禁掉的词**（用户 2026-10-07 点名的那几个 + 同义的两个）。
 *
 * 它们全都是"**给这张图下结论**"的说法，而**单看画面判断不了**：
 * 一帧静图看不出它是不是在动，也看不出它是不是从视频里截的。
 */
export const BANNED_WORDS_IN_PROMPT = ['动画', '动图', '视频', '会动', '循环', '动态图', 'GIF'];

/**
 * **代码兜底**要拒的措辞（比 {@link BANNED_WORDS_IN_PROMPT} **窄**）。
 *
 * 只认"这张图是动的/是视频"这一类**明确的下结论**，刻意**不含**：
 *
 * - 单独的 `循环` —— 「循环箭头图标」（回收标志）是**画面里真有**的东西；
 * - 单独的 `视频` —— 图里可能就印着"视频"两个字（截图、界面）。
 *
 * 提示词可以宽（那是引导），代码杀得太宽就是**误伤真话**。
 */
const JUDGEMENT_WORDING = /(动画表情|动图|动态图|会动的|会动|动起来|循环播放|播放动画|视频截图|视频画面|视频片段)/;

/**
 * 目标字数 → 真正的硬截上限。
 *
 * @param {number} target 目标字数（`describe(..., {maxChars})` 传的那个）
 * @returns {number}
 */
export function descHardLimit(target) {
  const t = Number.isFinite(target) && target > 0 ? Math.floor(target) : DEFAULT_MAX_DESC_CHARS;
  return Math.max(t, Math.ceil(t * DESC_HARD_LIMIT_RATIO));
}

/**
 * 目标字数达到这个量级，就按"**要写具体**"来措辞。
 *
 * 低于它的（比如表情包的 12 字）不加"写满"的催促 —— 那会把短标签也催长。
 */
const DETAILED_DESC_MIN = 30;

/**
 * 把外面传进来的长度收拾成一个能用的正整数目标；认不出就用兜底值。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function targetOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 描述里出现了"**给这张图下结论**"的措辞吗（动画/动图/视频/…）。
 *
 * @param {unknown} text
 * @returns {string|null} 命中的词；没有返回 null
 */
export function findJudgementWording(text) {
  const found = JUDGEMENT_WORDING.exec(String(text ?? ''));
  return found === null ? null : found[1];
}

/**
 * 给模型看的**长度 + 诚实**指令。跟着目标字数变，不写死。
 *
 * ⚠️ 措辞是"**大约 N 个字**"而不是"**不超过 N 个字**" —— 后者是个陷阱：
 * 模型会理解成"越短越好"，于是只写十来个字，**目标 50 就永远落空**
 * （用户点名说的就是这个："如果那里写的是'回一句简短的'，模型就只写 10 个字，
 * 截到 50 也是空的"）。长目标还要额外催一句，否则模型的默认习惯仍是只写一句。
 *
 * @param {number} target
 * @param {object} [options]
 * @param {number} [options.frames] 传了就是"多帧拼图"，说明清楚（**不说"动图"**）
 * @returns {string}
 */
function describeInstruction(target, { frames = 0 } = {}) {
  const parts = [];
  if (frames > 1) {
    // ⚠️ 措辞只说"同一个文件的 N 个画面，按时间从左到右"——**这是事实**（我们就是这么拼的）。
    //    绝不说"这是一张动图"：那正是用户禁掉的说法。
    parts.push(`这是同一个文件里按时间先后取出的 ${frames} 个画面，从左到右排列（不是 ${frames} 张不同的图）。`);
    parts.push('请把它们合成**一句**话：开头是什么样、中间变了什么、最后是什么样。');
  } else {
    parts.push(`用大约 ${target} 个字说清这张图里是什么（画面里的人物/物体、在做什么、周围场景，以及图上出现的文字）。`);
  }
  parts.push('只描述画面上看到的东西，不要评价、不要客套、不要"这张图片显示"这类开头。');
  parts.push(`⚠️ 不要写你看不出来的事：不要用「${BANNED_WORDS_IN_PROMPT.join('」「')}」这类词 —— 画面里判断不了它是不是在动、是不是视频，写了就是编。`);
  parts.push('看不出就不写；宁可少说一句，也不要猜一个词填上。');
  if (frames > 1) {
    parts.push(`整句控制在 ${target} 个字上下。`);
  } else if (target >= DETAILED_DESC_MIN) {
    parts.push(`${target} 个字是目标 —— 别只说"一个人"就停。`);
  }
  return parts.join('');
}

/** 一条消息最多描述几张图。防"一次发 30 张"把时间和钱烧光。 */
export const DEFAULT_MAX_IMAGES = 6;

/**
 * 图片描述的两套 system（2026-10-30 可配）。
 *
 * 这两个字符串是**搬迁前的原文**：`[vision_gate]` 里没写时逐个回退到它们，
 * 所以"没配"与"配成空"都不改变行为。
 */
export const DEFAULT_DESC_SYSTEM_DETAILED = '你只输出一句图片说明，不解释、不寒暄、不评价、不加引号。';
export const DEFAULT_DESC_SYSTEM_BRIEF = '你只输出一句极短的图片说明，不解释、不寒暄、不评价、不加引号。';

/** 描述缓存条数（**内存**那层）。同一张图（同 URL/文件名）不重复花钱。 */
export const DEFAULT_CACHE_SIZE = 200;

/** 单张图的描述超时。慢就放弃，别让一轮回复卡在描述上。 */
const DESCRIBE_TIMEOUT_MS = 20_000;

/**
 * **打模型**那一步的超时（2026-10-13 加）。
 *
 * 取 25s 的理由（不是拍的）：
 * - 实测云视觉 **~2.6s/张**（`qq-gugu.toml` 里那几行实测记录），本地 4B 冷启动
 *   最慢见过十几秒 ⇒ 25s 给足余量，正常情况**永远碰不到**这个上限；
 * - 它只兜"**挂住**"这一种病（连接建了、一个 token 都不回）。挂住的代价是
 *   无限等 + 主链路被拖住，所以宁可到点就放弃、退回占位符；
 * - 比字节超时（20s）略长：**下字节**和**打模型**是串行的两步，
 *   两步各自有界，合起来最坏 45s/张（预取之后这不再发生在派发路径上）。
 */
const DESCRIBE_MODEL_TIMEOUT_MS = 25_000;

/**
 * `Promise.race` + **计时器一定清掉**（2026-10-13）。
 *
 * 为什么不用 `AbortSignal.timeout()` 就完事：那个只让"给流的中止信号"到点触发，
 * 而流**在挂死时可能一个 chunk 都不产出、也不响应中止**（取决于适配器）——
 * 于是 `for await` 永远不返回。所以**必须**有一个自己会 reject 的计时器
 * 把控制权抢回来。两条一起用：`signal` 让底层请求早点断（省资源），
 * 计时器保证"这一轮一定会继续走"。
 *
 * ⚠️ 计时器**必须在两种结局里都清掉**（成功 / 失败），否则进程会被它吊着 ——
 * 一个 25s 的 `setTimeout` 足以让测试跑完还退不出去。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => void} onTimeout 到点时先做这个（通常是 `controller.abort()`）
 * @returns {Promise<T>}
 */
function withModelTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // 中止本身失败不该盖住"超时"这个事实。
      }
      reject(new Error(`图片描述：模型调用超时（${ms}ms 没有任何产出）`));
    }, ms);
    // `unref`：Node/定时器有它就别让它单独吊住事件循环（浏览器里没有这个方法）。
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 图片的稳定标识，用来做**内存**缓存键。
 *
 * `url` 优先（同一张图转发多次 URL 一致）；退到 `file`；都没有则返回空串
 * （调用方见空串就别缓存了，避免所有图挤在同一个键上）。
 *
 * ⚠️ 这只是"**这一进程内**够用"的键。跨会话那条路走**内容哈希**（见
 * `image-cache.mjs`）—— URL 会过期、file 名可能重写，只有字节哈希才是身份。
 *
 * @param {Record<string, unknown>} segment
 * @returns {string}
 */
export function imageKey(segment) {
  const url = typeof segment?.url === 'string' ? segment.url.trim() : '';
  if (url !== '') return url;
  const file = typeof segment?.file === 'string' ? segment.file.trim() : '';
  return file;
}

/**
 * **第一级**：QQ 自己给的图片文本（`summary`）。
 *
 * 实测（2026-10-07，`get_friend_msg_history` 的真实数据）：
 * 图片段的键固定是 `file,file_size,sub_type,summary,url`，
 * 普通照片的 `summary` 是**空串**，表情包（`sub_type: 1` / `7`）才有值。
 *
 * 所以这里只在**非空**时才认 —— 空串不是"描述为空"，是"QQ 没给"。
 *
 * @param {Record<string, unknown>} segment
 * @returns {string} 拿不到返回 `''`
 */
export function localImageLabel(segment) {
  const raw = segment?.summary ?? segment?.data?.summary;
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * QQ 给的标签是不是**"我也不知道这是什么"**的占位。
 *
 * 实拍：`sub_type: 7` 的表情包给的是 `summary: "[？]"` —— 这不是描述，
 * 是 QQ 自己**认不出这个表情**时打的问号。把它当成描述用，
 * 等于花了一轮却只往上下文里塞了个「？」，所以这种要**当成"没给"**，
 * 落到第二级去问视觉模型。
 *
 * 刻意只认「纯问号」这一种：别的标签（`[微笑]`、`[doge]`）都是有信息的，照用。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isUnknownImageLabel(value) {
  const inner = String(value ?? '').replace(/[[\]【】()（）\s]/g, '');
  return inner !== '' && /^[？?]+$/.test(inner);
}

/**
 * QQ 给的标签是不是**"给这张图下结论"**（而不是"描述画面"）。
 *
 * ## 这是 2026-10-07 实测抓出来的**真凶**
 *
 * 小鲸鱼报的是「一张单帧静图被描述成『动画表情』」，并推测是**模型**编的。
 * 但捞真实数据一看 —— **QQ 自己就把 `summary` 写成 `[动画表情]`**：
 *
 * ```
 * 136 张真实图片里：  ""(108)   "[动画表情]"(27)   "[？]"(1)
 * ```
 *
 * 27 张全是 `sub_type: 1`（QQ 的"动画表情"类型），而且**文件全是 `.jpg`**
 * —— 一张 jpg **不可能**在动。也就是说这条标签是 QQ 对"表情包类型"的分类，
 * **不是对画面的描述**；它和"我们实际拿到的那一帧是什么样"可以完全对不上。
 *
 * 更关键的是：它**绕过了模型**。`describe()` 第一级拿到 `summary` 就直接返回，
 * 提示词里禁什么都拦不住它 —— **只改提示词治不了这一条**。
 *
 * ## 所以怎么处理
 *
 * 和 `[？]` 同一个待遇：**当成"这不是描述"**，落到视觉那一级去描述**画面**
 * （"一只蓝发女孩表情呆滞"比"动画表情"有用得多，而且是**看得见**的东西）。
 *
 * 代价说清楚：
 * - 这类标签（27/136 ≈ 20%）从此**都要花一次视觉调用**（原来是零成本直接透传）；
 * - 没有视觉服务时（`attachments` 缺失）它们**拿不到描述**，退回占位符 ——
 *   这是**有意的**：用户的要求是"看不出就不说"，而不是"拿 QQ 的类型标签当画面描述"。
 *
 * 想回退：删掉 `describe()` 里那半句判定即可（另外**别**把 `[动画表情]` 加回描述里 ——
 * 用户明确禁掉了这个词）。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isAnimationClaimLabel(value) {
  const inner = String(value ?? '').replace(/[[\]【】()（）\s]/g, '');
  if (inner === '') return false;
  return /^(动画表情|动图|动图表情|gif表情|动态表情)$/i.test(inner);
}

// ══════════════════════════════════════════════════════════════════════════════
// 「认」：表情包的一次调用出全部（safe / reject / text / desc / tags / unmatched）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 表情包 `desc` 的目标字数（**"大约 20 字"**）。
 *
 * ⚠️ 措辞必须是"大约"而不是"不超过" —— 见 {@link describeInstruction} 那段注释
 * （用户点名过的坑：写成"不超过 N 字"，模型就只写十来个字）。
 */
export const STICKER_DESC_CHARS = 20;

/**
 * 配文的**字数红线**（默认 {@link MAX_STICKER_CAPTION_CHARS}）。
 *
 * ## 2026-10-09：从「主判据」降级成「兜底红线」
 *
 * 它原来是 **5**，也就是「配文超过 5 个字 ⇒ 拒」。抽样复核（80 格随机 + 40 格专项）
 * 证明**这条判据本身就是误杀的 100% 来源**：被拒的 80 格里 14 格是明确该收的表情包，
 * **14/14 的拒因都是 `text`**；而**"带字"恰恰是表情包的主力**（熊猫头、梗图、吐槽图
 * 全靠字）。配文长度分布也印证了悬崖就在 6 个字：恰好 6 字的 46 条、≤15 字的占 61%。
 *
 * ⇒ 主判据换成 {@link sanitizeStickerVerdict} 里的 **`pureText`（是不是纯文字图）**；
 *   这一个数字**只留下"长到不可能是表情包"的兜底作用**，默认从 5 提到 **120**。
 *   依据（2026-10-09 实测，126 张样本、同一后端 18602）：**收下的、带配文的图里最长的配文
 *   是 59 字**（`2f4fb0eb`，一张配了调侃文字的黑白梗图）；取 **2 倍余量** ⇒ 120。
 *   而在这 126 张上 60 与 120 的判定结果**完全一致**（唯一一条 `text` 拒绝来自 `pureText`，
 *   与字数无关）⇒ 提高它在这批数据上零代价，只是给"配文更长的梗图"留出余量。
 *
 * ⚠️ **它只是兜底**：防的是"模型说 `pureText=false`、却把一整段文字抄下来"那种
 * 自相矛盾的回复（那样 `captionChars` 会是几百）。
 *
 * ⚠️ **它仍然由代码强制**（{@link sanitizeStickerVerdict}），**不信模型自述**：
 * 它是判定里**唯一可独立复核**的一条 —— `caption` 是模型自己抄下来的配文，数一数就知道。
 * ⚠️ 而且判定用的是**未截断的真长度**（见 {@link cleanStickerCaption} 里那个"死旋钮"的注释）。
 *
 * ⚠️ 真正的值来自 `[sticker_gate] captionMaxChars`（用户可调）；这个常量只是兜底默认。
 * 口径是**码点**（`Array.from(s).length`），和 `desc` 那边一致，emoji 不会被拆成两半。
 */
export const MAX_STICKER_CAPTION_CHARS = 120;

/**
 * `caption` 最多留多少字（**只为日志/落盘可读**；判定用的是**未截断的真长度**）。
 * 一份聊天记录截图可能有几百字，全留着只会把日志淹掉。
 * ⚠️ 这个数**和判定无关** —— 它必须**永远小于等于** `captionMaxChars` 才有意义，
 * 但判定不看它（2026-10-09 修的那个"死旋钮"就是这里先截断、再判长度导致的）。
 */
export const MAX_STICKER_CAPTION_KEEP = 40;

/**
 * 打分的键名（**固定顺序**，契约、日志、计数器都按这个顺序）。
 *
 * 用户 2026-10-08 原话：「我要求 nsfw 这块**分开来**，并且改成打分，0 代表否定
 * （无此方面要素），10 代表肯定（有此方面要素）」⇒ **各项必须分开**，
 * 绝不能合成一个"总风险分"（合起来就分不出"哪条判据在拦"，阈值也没法分别调）。
 *
 * ## 2026-10-09 新增 `funny`（**这是本次最重要的改动**）
 *
 * 用户原话：「你会发现现在**没有任何一项是评价这张图是否有趣**」。
 *
 * 原来的四项**全是负面筛选**，逻辑是「没毛病吗？没毛病 ⇒ 收」⇒ **必然宽松**：
 * 一张随手拍的猫、一张新闻截图确实"没毛病"（没色情没暴力也不丑）⇒ 于是全过。
 * 实测误收 **40%**（收下的 1126 张里约 450 张是脏图）就是这么来的。
 *
 * 加上 `funny` 之后逻辑变成「**有趣吗？不够有趣 ⇒ 不收**」—— 那才是从根上治误收。
 *
 * ⚠️ **它和其余四项的阈值方向相反**（其余是"高了才拒"，它是"低了才拒"），
 * 所以拒因的名字**不叫 `funny` 而叫 `boring`** —— 日志里出现 `reject: 'boring'`
 * 才不会让人误会成"因为太有趣而被拒"。见 {@link REJECT_REASONS}。
 */
export const STICKER_SCORE_KEYS = Object.freeze(['nsfw', 'violence', 'gore', 'ugly', 'funny']);

/** 打分的满分。契约就是 0-10；给到这个范围之外的数**当没看成**处理（不夹）。 */
export const STICKER_SCORE_MAX = 10;

/**
 * 「认」那一次调用的输出 token 预算：**默认值**与**合法区间**。
 *
 * - **默认 420** = 2026-10-10 之前硬编码的那个数，**保持现状不变**（本地 4B 没有思维链，够用）。
 * - **上限 8192**：比任何 OpenAI 兼容端点的常见输出上限都松，它只用来挡住"手滑多写一位"
 *   （比如把 2000 写成 20000）—— 那种值会在**请求那一层**被拒，比夹紧要难查得多。
 * - **下限 64**：低于它连一份完整的 JSON 契约都装不下，属于"配了就等于全拒"。
 *   夹到 64 而不是抛异常：这一节在用户手改的 toml 里（同 {@link normalizeStickerGate} 的规矩）。
 */
export const DEFAULT_STICKER_MAX_TOKENS = 420;
export const STICKER_MAX_TOKENS_MIN = 64;
export const STICKER_MAX_TOKENS_MAX = 8192;

/**
 * 审核闸的**兜底默认值**。
 *
 * ⚠️ **真源是 `qq-gugu.toml` 的 `[sticker_gate]`**（用户点名要求：提示词与阈值都放那儿）。
 * 这里这份只在"toml 没写 / 读不到"时生效，而且 `prompt` 留空 ——
 * 那样会退回 {@link DEFAULT_STICKER_PROMPT}。
 *
 * 阈值的语义：**风险项低于才收**（`scores.ugly >= uglyMax` ⇒ 拒）。默认 4 ⇒ 0/1/2/3 收、4 拒。
 * ⭐ **`funny` 是唯一方向相反的一项**：`scores.funny < funnyMin` ⇒ 拒（默认 3）。
 *
 * `provider` / `model` 留空 ⇒ **交给 `visionGate` 自动选**（本地/云，按空闲显存）；
 * 写了则**手动赢**，门控不插手。
 * ⚠️ **2026-10-09 更正**：原来这里写的是「留空 = 沿用那条**云视觉**路径」——
 * 那是**门控加进来之前**的语义。现在 `resolveRoles()` 的 `hasOverride === false`
 * ⇒ **照常走门控**。"留空"= 让门控接管，不是"固定走云"。
 */
export const DEFAULT_STICKER_GATE = Object.freeze({
  prompt: '',
  provider: '',
  model: '',
  nsfwMax: 4,
  violenceMax: 4,
  goreMax: 4,
  uglyMax: 4,
  /** ⭐ 有趣度的**下限**：低于它 ⇒ 拒（原因 `boring`）。见 {@link STICKER_SCORE_KEYS}。 */
  funnyMin: 3,
  captionMaxChars: MAX_STICKER_CAPTION_CHARS,
  /**
   * ⭐ 「认」那一次调用给模型多少输出 token。**为什么它必须可配**：
   *
   * 它够不够用**取决于模型有没有隐藏思维链，而不取决于模型强不强** ——
   * 没有思维链的模型（本地 4B）几百 token 就够；有思维链的模型（云端）会在
   * 写 JSON 之前先花掉一大截预算，同一个数就可能**在 JSON 中途把回复切断**。
   * 那一断的表现是 `ok:false`（"没看成"）⇒ 按不可信 fail-closed **拒掉** ——
   * **和"模型判得严"长得一模一样**，所以这个值必须能跟着模型一起调。
   *
   * ⚠️ **这不是"越高越好"的旋钮**：给太高只是浪费，给太低才会静默拒图。
   * ⇒ 换 `provider`/`model` 时**必须连带检查它**（见 {@link callVision} 的截断告警）。
   */
  maxTokens: DEFAULT_STICKER_MAX_TOKENS,
  /**
   * ⭐ 2026-10-10：「认」那一次调用**要不要让模型思考**（默认 `false` = 不要）。
   *
   * ## 它怎么落地（**这条决定了它能不能生效，别跳过**）
   *
   * 实测背书（同提示词、20 张图、按量端点）：关掉思考 **快 4.8×**（12.52 s → 2.60 s）、
   * `reasoning_tokens` 14717 → 0，而收/拒判定**完全一致**（A 组 8/8、B 组 6/6）。
   *
   * ⚠️ **但它不是一个"往请求体里塞字段"的旋钮** —— DSH 的 LLM 环缝只认契约字段
   * （`GenerateOptions`: provider/model/reasoningEffort/messages/system/tools/temperature/
   * maxTokens/stop/signal/sessionId/purpose），**多余的键会被适配器静默丢掉**。
   * 所以这一项**改成只驱动那一次调用的 `reasoningEffort`**：
   *
   * | `enableThinking` | 这次调用传什么 | 线上表现（由 provider 适配器决定） |
   * |---|---|---|
   * | `false`（默认） | `reasoningEffort: 'off'` | pi-ai 路由：**省略** reasoning 参数；`dsh-llm-deepseek`（Messages）路由：`thinking:{type:'disabled'}` |
   * | `true` | **不发** `reasoningEffort` | 交给 provider 自己的默认档（通常就是"思考开"） |
   *
   * 🔴 **一个必须知道的边界**：pi-ai 的 `openai-completions` 只在
   * `model.reasoning === true` 且 `compat.thinkingFormat` 是 `qwen`/`qwen-chat-template`/
   * `chat-template`/`baseten` 时才会发出 `enable_thinking`。
   * 而路由里**手写**（不在内置目录里）的模型默认 `reasoning: false` ⇒
   * **`enable_thinking` 一个字节都不会发**，`reasoningEffort: 'off'` 只是"参数缺席"。
   * ⇒ 想让"关思考"真的改变线上请求，得在 `cordis.patch.yml` 的
   * `llm-pi-ai.providers.<路由>.models[]` 上给那个模型声明
   * `reasoningEfforts`（例如 `{off: null, low: "low"}`）+ `compat: {thinkingFormat: qwen}`。
   * **那是 provider 配置，不是本文件能做的事** —— 本文件只保证"插件侧的意图"是真的、
   * 可观测的（见 {@link createImageDescriber} 的 `stickerGate` 快照与 `index.mjs` 的挂载日志）。
   *
   * ⚠️ `true` 时**不是**发 `reasoningEffort: 'low'`：手写模型只支持 `off`
   * （`resolveCallConfig` 会直接抛 `UNSUPPORTED_REASONING_EFFORT`）⇒ 只能"不发"。
   */
  enableThinking: false,
});

/**
 * 提示词模板（**照例 toml 里那份和它逐字相同**；toml 留空时用这份）。
 *
 * ⚠️ 2026-11-06 已知漂移：新标签 `幸灾乐祸` 的**语义分界那一段**只加在了这份代码兜底里，
 * 线上真 toml（`<DSH_HOME>\profiles\<profile>\qq-gugu.sticker.toml` 的 `[sticker_gate] prompt`）
 * 还没有它 —— 那次改动的边界是"不碰 `<DSH_HOME>` 的 toml"。**模型读的是 toml 那份**，
 * 所以要真正生效，需要有人把这段同步进 toml（同一天改的那 4 条格式规则也是这么同步的）。
 *
 * ⚠️ **不要在这里手改文案**：改提示词请改 `qq-gugu.toml` 的 `[sticker_gate] prompt`
 * —— 用户点名的要求就是"提示词不能在代码里"。这份存在的唯一理由是
 * "toml 读不到时也得能跑"（部署在别处、测试环境）。
 *
 * 占位符（运行期由 {@link buildStickerInstruction} 填）：`{intro}` / `{descChars}` /
 * `{tags}` / `{banned}`。⚠️ 不用反引号或 `${}` 写，是因为这段文本**要原样进 toml**，
 * 在 TOML 里那些字符只会变成噪声。
 */
export const DEFAULT_STICKER_PROMPT = `{intro}
只输出一个 JSON 对象，不要任何别的内容：不要 markdown 代码块、不要解释、不要在 JSON 外面加任何字。
{"isSticker":true,"portrait":false,"screenshot":false,"political":false,"pureText":false,"scores":{"nsfw":0,"violence":0,"gore":0,"ugly":0,"funny":0},"caption":"","desc":"大约 {descChars} 个字的画面描述","tags":["从下面选 1-3 个"],"unmatched":""}

【五项打分，每项 0-10】0 = 完全没有这方面要素，10 = 明确有。你只负责如实打分，"收不收"由代码按阈值决定。
- nsfw 色情：裸露、性暗示、性行为、挑逗姿势
- violence 暴力：打斗、攻击、威胁、武器指着人
- gore 血腥：伤口、出血、尸体、内脏、虐待
- ugly 丑：**字面意义的丑** —— 脏、恶心、让人不适（污渍、垃圾、腐烂、排泄物、反胃的画面）
- funny 有趣：这张图**本身好笑 / 好玩 / 有梗**，值得被人当表情包发出去取乐
五项互相独立，都要给分；没有就给 0。两条口径必须记牢：
- ⚠️ ugly **只管"脏"和"字面意义的丑"**。**画面内容夸张、扭曲、变形不算 ugly** —— 那常常是梗图的笑点（例如猫弓起背把身体扭成奇怪形状、一张脸被挤到变形），该在 funny 上给高分。
- ⭐ funny 是**唯一一个正面分**：越高越有趣。随手拍的照片（宠物、真人、食物、实物）、风景、商品、截图、纯文字文档，都该给 0-2 分 —— 它们不有趣。明确好笑的梗图 / 表情包 / 反应图给 8-10 分。
- 不要因为"整体看着还行"就把五项全给 0，也不要因为"有点怪"就全给高分。

【portrait】画面主体是真人照片（相机拍的真实人物，含自拍）就填 true；动漫、插画、卡通、游戏 CG、表情包画风都填 false。
【screenshot】这张图**整张**是不是**屏幕，或屏幕的复制品**？是就填 true。
⚠️ 判据是「**你看到的画面就是屏幕本身的内容**」。
下面这些**算**（true）：
- 聊天记录、网页、软件界面、游戏界面、手机界面
- 画面里出现**手机状态栏**（电量 / 信号 / 时间那一行）
- 画面角上有**拍摄设备水印**（vivo X100 Pro、HUAWEI P60、Xiaomi 14 这类手机相机水印）
- **翻拍屏幕**：摩尔纹、屏幕反光、看得见屏幕边框、明显歪着拍
下面这些**不算**（false）：
- **动漫角色在看手机 / 对着电脑**、**实拍照片里有一台显示器或一部手机** —— 那是"画面里出现了屏幕"，**不是**"这张图是屏幕"
- **图里画着一个界面，但那是插画**
- **平台水印**（贴吧、抖音、B站、微博、小红书的角标或水印）—— 表情包常常自带这些，那是表情包本身的一部分
- 它本来就是一张画出来、或拍出来的图
【political】涉政：画面里出现**政治人物**（真人、漫画、恶搞都算）、**政治标语 / 口号**、**国家象征**（国旗、国徽、党徽、有争议的地图图案）、**敏感历史或时事事件**的符号 ⇒ 填 true。
⚠️ **爱国、爱党的正常表达不算涉政**（国旗配"我爱你中国"、正常的国庆祝福之类）⇒ 填 false。
⚠️ 这条**没有阈值、也不细分** —— 判 true 代码就直接拒。

【isSticker】这张图本身是不是一张表情包 / 梗图：是就填 true，不是就填 false。它判的是「这图能不能当表情包用」，跟好不好看、干不干净无关。
下面这些 isSticker = true：
- 动漫角色抱头，配字「绷不住了」
- 熊猫头梗图，人物手指向上指，配字「看名字需要加我」
- 纯文字梗图，白底黑字「你先别急」
下面这些 isSticker = false：
- **真实动物照片**：随手拍的猫、狗、仓鼠、鸟 —— 没有配字、没有夸张表情，只是"在看着镜头"
- **游戏画面截图**（Minecraft、像素风游戏、手游界面、带血条 / 技能栏 / 手柄 UI 的）
- **QQ 聊天界面截图**（聊天气泡、联系人列表、设置页）
- **手办 / 玩偶的实拍**（摆在桌上或垫子上的模型、玩偶、挂件）
- 一张风景照（海边、山）、房间里拍的生活照
- 商品页截图、快递单、证件、地图、报表、纯文档截屏
⚠️ **但真实动物的照片也可以是表情包** —— 区别不在"拍的还是画的"，而在**这张图有没有"戏"**：
- 狗张大嘴巴咆哮、白猫瞪大眼睛吐舌头、猫扭成奇怪形状 ⇒ **表情 / 姿态有戏**，是表情包 ⇒ true
- 猫趴在路边抬头看镜头、河对岸一只猫、宠物在睡觉 ⇒ **只是一张随手拍** ⇒ false
判断方法：带角色 / 动物 / 表情的反应图、网络梗图、聊天用的贴图、动漫或游戏截图配上吐槽文字、纯文字梗图 ⇒ true；风景照 / 生活照 / 商品图 / 证件照 / 地图 / 报表 / 纯截屏 / 纯文字文档，以及没有「表达情绪或吐槽」意图的图 ⇒ false。
一句话口径：**如果别人把这张图发到群里，你会当表情包存下来，还是当照片划过去？** 当表情包存 ⇒ true；当照片划过去 ⇒ false。

【pureText】这张图是不是一张**纯文字图**？判据是：**图上除了"字"之外没有别的内容**（没有角色、动物、人物、物体、照片）。
算（true）：
- 白底或纯色底 + 一整段文字、清单、表格、报表
- 一整屏**基本上全是字**的截图：长文、代码、日志、Token 串、**聊天记录里成段的对话文字**
不算（false）：
- **有画面主体的、带字幕的表情包**（有角色 / 动物 / 物体 + 配字）
- **一句吐槽的梗**（白底黑字一行字，或者一张纯色卡片刻了一句话），例如「你先别急」「老子拒绝」「这不是 bug，这是一个特性」
⚠️ 这条**没有阈值**：判 true 代码就直接拒。它是用来拦"纯文字图 / 长文图 / 文档图"的，**不是**用来拦带字表情包的。

【caption = 配文】只抄「作者写给读者看的那句话」，不是图上所有字。
下面这些算配文，要抄进 caption：
- 表情包底部的一行字：「我裂开了」
- 对话气泡里的字：「你说啥？」
- 顶部的大字：「震惊」
下面这些不算配文，不要抄、也不要数：
- 帽子上的字母 JOJO
- 衣服上的字母 ADIDAS
- 背景招牌上的字「便利店」
- 书本封面上的标题
- 画面里出现的聊天记录截图里的字（那是截图，另有判据）
判断方法：这句话是作者写给读者看的（吐槽、台词、标题），才算配文；它只是画面里某个东西自带的标识（商标、球衣号码、路牌、书名），就不算。
caption 原样抄配文，一个字都不要改、不要翻译、不要概括；没有配文就留空串。

【desc】用大约 {descChars} 个字说清画面里是什么（人物/物体、在做什么、周围场景）。
【tags】只能从这个列表里选，不要造新词、不要改字：{tags}。
【tags 的语义分界】最容易混的三个必须分清：「幸灾乐祸」= 看**别人**倒霉 / 出丑时的笑（笑的是别人，画面常常是笑着看戏），**不是安慰、也不是自嘲**；「调侃吐槽」= 嘴上损人、阴阳怪气，落点在「说」；「得意自信」= 笑自己 / 炫耀自己，落点在「我」。
⚠️ tags 是**数组**，**每个元素只放一个**枚举值（照抄那四个字），1-3 个，各自独立：
- 对：["调侃吐槽","幽默搞笑","无语无奈"]（三个元素）
- 对：["卖萌可爱"]（一个元素）
- 错：["调侃吐槽/幽默搞笑/无语无奈"]（把几个词用斜杠挤成一个元素 ⇒ 整条会被丢掉）
选不出合适的就写 []，并把你想用的词填进 unmatched（最多 8 个字）。
⚠️ 不要写你看不出来的事：不要用「{banned}」这类词 —— 画面里判断不了它是不是在动、是不是视频，写了就是编。`;

/**
 * 把外面（toml / 配置 / 测试）给的审核闸参数收拾成能用的形状。
 *
 * ⚠️ **越界的数一律夹到边界，不抛异常、也不静默丢弃** —— 调用方
 * （`index.mjs` 的 `loadStickerGate`）会把"夹过"的字段**打成 warn**。
 * 为什么不直接抛：这一节在**用户手改的 toml** 里，写错一个数字不该让小鲸鱼整个起不来；
 * 但"夹了却不吭声"是这个项目最贵的一类坑（配置写了、计数正常、什么都没发生），
 * 所以夹紧必须**留下痕迹**。
 *
 * @param {unknown} raw
 * @returns {{prompt: string, provider: string, model: string, nsfwMax: number, violenceMax: number, goreMax: number, uglyMax: number, funnyMin: number, captionMaxChars: number, maxTokens: number, enableThinking: boolean}}
 */
export function normalizeStickerGate(raw = {}) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const intIn = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  /**
   * 布尔项：**只认真正的布尔值**（TOML 的 `true` / `false`）。
   *
   * ⚠️ 认不出就用兜底值，**而这个"夹紧"必须留痕** —— `index.mjs` 的
   * `loadStickerGate` 会把"写了但不是布尔"逐个打 warn（同 {@link maxTokens} 那条规矩）。
   * 为什么不像数字那样"能转换就转换"：`"false"`、`0`、`"no"` 这类值的语义有歧义，
   * 猜错的方向是"把审核闸的思考悄悄打开/关掉"，而它**不报错、计数正常** ——
   * 正是这个项目最贵的那类坑。宁可回退默认值 + 留一条 warn。
   *
   * @param {unknown} value
   * @param {boolean} fallback
   * @returns {boolean}
   */
  const boolIn = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  return {
    prompt: typeof src.prompt === 'string' ? src.prompt : '',
    provider: text(src.provider),
    model: text(src.model),
    nsfwMax: intIn(src.nsfwMax, DEFAULT_STICKER_GATE.nsfwMax, 0, STICKER_SCORE_MAX),
    violenceMax: intIn(src.violenceMax, DEFAULT_STICKER_GATE.violenceMax, 0, STICKER_SCORE_MAX),
    goreMax: intIn(src.goreMax, DEFAULT_STICKER_GATE.goreMax, 0, STICKER_SCORE_MAX),
    uglyMax: intIn(src.uglyMax, DEFAULT_STICKER_GATE.uglyMax, 0, STICKER_SCORE_MAX),
    funnyMin: intIn(src.funnyMin, DEFAULT_STICKER_GATE.funnyMin, 0, STICKER_SCORE_MAX),
    captionMaxChars: intIn(src.captionMaxChars, DEFAULT_STICKER_GATE.captionMaxChars, 0, 200),
    // ⚠️ 加进这一节就**必须**同时加进 `index.mjs` 的 `loadStickerGate` 那个夹紧 warn 列表 ——
    //    两处一一对应（漏了就是"写越界静默夹紧、日志里一个字都没有"）。
    maxTokens: intIn(
      src.maxTokens,
      DEFAULT_STICKER_GATE.maxTokens,
      STICKER_MAX_TOKENS_MIN,
      STICKER_MAX_TOKENS_MAX,
    ),
    // ⭐ 2026-10-10：不是布尔值（`"false"` / `0` / 写错键名…）⇒ 回退默认 + 留 warn。
    enableThinking: boolIn(src.enableThinking, DEFAULT_STICKER_GATE.enableThinking),
  };
}

/**
 * `reject` 允许的取值（**封闭枚举**，而且就是 {@link sanitizeStickerVerdict} 报原因的**优先级**）。
 *
 * | 代号 | 触发条件 | 有阈值吗 |
 * |---|---|---|
 * | `political` | ⭐ 模型判 `political === true`（**涉政一律全禁**，2026-10-09 用户拍板） | ❌ **命中即拒** |
 * | `portrait` | 真人照片 | ❌ **命中即拒**（红线，不该和"丑"混在一个旋钮里） |
 * | `screenshot` | 屏幕 / 屏幕的复制品（聊天记录 / 网页 / 游戏界面 / **手机状态栏** / **拍摄设备水印** / 翻拍屏幕） | ❌ **命中即拒** |
 * | `not-sticker` | 模型判 `isSticker !== true`（风景照 / 生活照 / 商品图 / 证件 / 地图 / 报表 / 纯文档） | ❌ **命中即拒** |
 * | `text` | ⭐ 模型判 `pureText === true`（**纯文字图**），或配文字数 `> captionMaxChars`（兜底红线） | 前一半没有；后一半有（`captionMaxChars` = 60） |
 * | `boring` | ⭐ 有趣度**不够**：`scores.funny < funnyMin` | 有（`funnyMin`，方向**相反**） |
 * | `nsfw` / `violence` / `gore` / `ugly` | 对应那一项打分 `>= 阈值` | 有（各自一个） |
 *
 * ⚠️ `screenshot` 是 2026-10-08 补的：新契约（打分制）原本只列了 `portrait`，
 * 但提示词里"聊天记录截图里的字**不算配文**"那句写着"（那是截图，另有判据）"——
 * 少了这一条，一张配文很短的长截图会**顺着 `captionChars` 溜进去**。
 *
 * ⚠️ `not-sticker` 是 **2026-10-09** 补的：上面那几条判据**都默认"它已经是一张表情包"**，
 * 没人问过"它到底是不是"。风景照 / 生活照 / 商品图 / 地图这些恰好 `portrait=false`、
 * `screenshot=false`、各项全 0、也没有配文 ⇒ **一条都不拦**。
 * 顺序刻意排在 `portrait` / `screenshot` **之后**：那两条更早就在，
 * 让它们先报，老日志 / 老计数里的 `reject` 分桶就**一个字都不变**。
 *
 * ⭐ **2026-10-09 的判据重写**（依据：`shared\tmp\2026-10-09-联络表抽样复核-session-00000000.md`）：
 *
 * - **新增 `political`，排在**第一个 —— 用户拍板「涉政直接拒，不细分、不打分、不看阈值」。
 *   排在首位是因为它是**最高优先级的红线**：一张既涉政又像截图的图，日志里该先看见"涉政"。
 * - **新增 `boring`**（有趣度不足）—— 原来那几项**全是负面筛选**（"没毛病就收"⇒ 必然宽松，
 *   实测误收 40%）。加上它之后逻辑变成"不够有趣就不收"，从根上治误收。
 *   ⚠️ 名字**故意不叫 `funny`**：它的触发条件是"分**低**"，叫 `funny` 会让人读成"因为太有趣而拒"。
 * - **`text` 的含义换了**：从「配文 > 5 字」（**误杀的 100% 来源**，14/14）改成
 *   「**是不是纯文字图**」（`pureText`）。它现在排在 `not-sticker` 之后、`boring` 之前：
 *   "这是不是一张图"比"这张图有没有趣"更根本。
 * - 顺序里 `nsfw/violence/gore/ugly` 仍是最后 —— 实测它们**几乎没用上**
 *   （2197 张里任一项 >0 的只有 41 张 = 1.9%），真正干活的是前面那几条非打分判据。
 */
export const REJECT_REASONS = Object.freeze([
  'political', 'portrait', 'screenshot', 'not-sticker', 'text', 'boring',
  'nsfw', 'violence', 'gore', 'ugly',
]);

/**
 * **没看成**时的返回值（没有视觉服务 / 取不到字节 / 不是 JSON / `scores` 不完整）。
 *
 * ⚠️ **fail-closed**：`ok:false` + `accept:false` —— 调用方**不许**把它当"可以收"。
 * 为什么每个字段都给具体值（而不是 `null`）：契约里字段的类型是固定的，
 * 多一个 `null` 只会让每个调用方都写一遍防御；而"默认不收、明确说收才算收"
 * 正是审核闸该有的方向。
 *
 * ⚠️ `ok` 与 `accept` **必须分开**：`ok` 是"真的拿到一个完整判定"，
 * `accept` 才是"收不收"。没看成时两个都是 false，但**原因完全不同** ——
 * 合成一个布尔，"模型没答"和"分数超了"在统计上就再也分不开了。
 */
export const STICKER_VERDICT_FAILED = Object.freeze({
  ok: false,
  accept: false,
  reject: null,
  rejects: Object.freeze([]),
  // ⚠️ `isSticker` 的默认值是 `false`（和 portrait / screenshot / political / pureText 同一条口径）：
  //    "没看成"与"判它不是"靠 `ok` + `reject:null` 区分，不靠这些布尔。
  isSticker: false,
  portrait: false,
  screenshot: false,
  political: false,
  pureText: false,
  scores: Object.freeze({ nsfw: 0, violence: 0, gore: 0, ugly: 0, funny: 0 }),
  caption: '',
  captionChars: 0,
  desc: '',
  tags: Object.freeze([]),
  unmatched: '',
  /** ⭐ 感知哈希（dHash，16 个十六进制字符）；算不出来就是空串。见 {@link perceptualHashHex}。 */
  phash: '',
});

/** {@link STICKER_VERDICT_FAILED} 的一份**可变副本**（里面那两个对象/数组是冻结的，不能直接往下传）。 */
export function failedStickerVerdict() {
  return {
    ...STICKER_VERDICT_FAILED,
    rejects: [],
    scores: { ...STICKER_VERDICT_FAILED.scores },
    tags: [],
  };
}

/**
 * 四项打分：**四项都必须是 0-10 的数**，否则算"模型没答全"（返回 `null`）。
 *
 * 三条口径，每条都对着一个具体的失败模式：
 *
 * 1. **缺一项就整条不算**：只拿到三项时，"第四项到底几"是**未知**，
 *    而未知**不能当 0**（那是"当作完全没有"，恰好落在最宽松的一侧）；
 * 2. **数字字符串认**（`"3"`）：弱模型很爱把数字写成字符串，这不算不守约；
 * 3. **范围外不夹**（`11` / `-1`）⇒ 直接不合格。契约写的是 0-10，给了 11 就是不守约，
 *    按不守约处理比"猜他想说 10"更诚实（而且不守约这件事本身要能被看见）。
 *
 * @param {unknown} raw 模型给的 `scores` 字段
 * @returns {{nsfw: number, violence: number, gore: number, ugly: number, funny: number}|null}
 */
export function normalizeStickerScores(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of STICKER_SCORE_KEYS) {
    const value = raw[key];
    const n = typeof value === 'number'
      ? value
      : (typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN);
    if (!Number.isFinite(n) || n < 0 || n > STICKER_SCORE_MAX) return null;
    out[key] = n;
  }
  return out;
}

/**
 * **一个"必须真布尔"的旗标**（`isSticker` / `political` / `pureText` 共用）。
 *
 * 三态，刻意把"未知"和"否"分开：
 *
 * | 模型给的 | 这里返回 | 后果 |
 * |---|---|---|
 * | `true` | `true` | 这一条不拦（`political` / `pureText` 反过来：拒） |
 * | `false` | `false` | 依旗标而定（`isSticker` ⇒ 拒 `not-sticker`；`political`/`pureText` ⇒ 不拦） |
 * | 缺失 / `null` / 字符串 / 数字 / 对象 | `null` | **`ok:false`（没看成）**，不入库 |
 *
 * **为什么缺失 = `ok:false` 而不是当 `false`**：与 {@link normalizeStickerScores} 同一条规矩 ——
 * 未知不能当"没有"。"模型没答这个字段"只说明这次判定不完整，**不等于它说这张图不是表情包 /
 * 不涉政 / 不是纯文字图**；混起来之后，"模型不会用这个字段"和"模型真判它是"在统计上就
 * 再也分不开了（而这两种情况的处置完全相反：前者要改提示词，后者要把图拦下来）。
 *
 * **为什么不认 `"true"` 这种字符串**（`scores` 那边是认数字字符串的）：布尔没有
 * "写成字符串仍无歧义"的必要，放宽只会多一条来路不明的 `true`。
 * fail-closed 的代价只是"这张图这次不入库、下次它再出现时重认一遍"，比错收一张风景照便宜。
 *
 * @param {unknown} raw 模型给的那个字段
 * @param {string} name 旗标名（进 `notes`，形如 `political-missing` / `political-invalid`）
 * @param {string[]} [notes] 命中原因往这里追加
 * @returns {boolean|null} `true` / `false` / `null`（= 没看成）
 */
export function readStickerFlag(raw, name = 'isSticker', notes = []) {
  if (raw === true) return true;
  if (raw === false) return false;
  notes.push(raw === undefined ? `${name}-missing` : `${name}-invalid`);
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 感知哈希（近似图去重）—— **纯计算层，一次模型调用都不发**
// ══════════════════════════════════════════════════════════════════════════════

/** dHash 的采样格：**9 列 × 8 行** ⇒ 每行 8 次"左>右"比较 ⇒ 64 位。 */
export const PHASH_COLS = 9;
export const PHASH_ROWS = 8;

/**
 * 算 GIF 感知哈希时**最多扫几帧**（挑"不透明像素最多"的那一帧）。
 *
 * ⚠️ 不能只看第一帧：GIF 的帧可以只覆盖画面的一小块（帧间优化），
 * 第一帧**可能**只是个补丁 ⇒ 拿它哈希等于在哈希"白底 + 角落里一小块"。
 * 8 帧是经验值：绝大多数 GIF 的关键画面在前 8 帧内就会出现，而代价可控。
 *
 * ⚠️ **诚实标注**：这个改动**没有实测案例背书** ——
 * 我当初举的那个例子（`_rerun2/7c3ac6c5`）实测**只有 1 帧**，问题不在帧，而在"近乎纯色"。
 * ⇒ 它是一条**防御性**改动（比"只解第一帧"更稳），不是修某个已观测到的 bug。
 */
export const PHASH_SCAN_FRAMES = 8;

/**
 * 两张图**汉明距离**到多少以内算"同一张"。默认 6 / 64 位。
 *
 * ⚠️ 这是**启发式**，不是从数据标定出来的（这批语料里没有人工标过"哪两张是同一张"）。
 * 取值的依据：同一张图**重新编码 / 改一档 JPEG 质量 / 加一次缩放**，实测级别的扰动
 * 通常落在 0-3 位；完全无关的两张图在 64 位里平均差 32 位、几乎不会低于 12 位。
 * ⇒ 6 落在"明显是同一张"和"明显不是"之间的空档里，偏保守（宁可漏判，不愿把两张
 * 不同的表情包当成一张丢掉）。要更激进就把它调大。
 */
export const DEFAULT_PHASH_MAX_DISTANCE = 6;

/**
 * RGBA 像素 → **dHash**（差值哈希，64 位 = 16 个小写十六进制字符）。
 *
 * 为什么是 dHash 而不是 aHash：dHash 比的是**相邻像素的明暗关系**，
 * 对整体亮度变化（曝光不同、加了半透明水印）不敏感，而对结构变化敏感 ——
 * 正是"同一张图不同编码"这个场景要的性质。
 *
 * 三个刻意的选择：
 * 1. **自己写盒式缩放**（不用 `gif.mjs` 的 `resizeRgba`）：那个函数"目标比源大就不放大"，
 *    遇到 89×20 这种小图会返回原尺寸，这里按下标取样就会越界。这里保证**永远输出 9×8**；
 * 2. **透明像素按白底合成**：GIF 的透明背景很常见，按黑底算会把整张图算成"全暗"，
 *    于是所有带透明背景的图互相都像；
 * 3. **零依赖、无 I/O、不看像素以外的东西** ⇒ 能单独测（见 `test/sticker-phash.test.mjs`）。
 *
 * @param {Uint8Array} rgba 每像素 4 字节（R,G,B,A）
 * @param {number} width
 * @param {number} height
 * @returns {string} 16 个十六进制字符；参数不对就是 `''`
 */
export function perceptualHashRgba(rgba, width, height) {
  if (!(rgba instanceof Uint8Array)) return '';
  if (!Number.isFinite(width) || !Number.isFinite(height)) return '';
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w <= 0 || h <= 0) return '';
  if (rgba.length < w * h * 4) return '';

  const cols = PHASH_COLS;
  const rows = PHASH_ROWS;
  const gray = new Float64Array(cols * rows);
  for (let dy = 0; dy < rows; dy += 1) {
    const y0 = Math.floor((dy * h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * h) / rows));
    for (let dx = 0; dx < cols; dx += 1) {
      const x0 = Math.floor((dx * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * w) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y += 1) {
        for (let x = x0; x < x1 && x < w; x += 1) {
          const at = (y * w + x) * 4;
          const a = rgba[at + 3] / 255;
          const r = rgba[at] * a + 255 * (1 - a);
          const g = rgba[at + 1] * a + 255 * (1 - a);
          const b = rgba[at + 2] * a + 255 * (1 - a);
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          n += 1;
        }
      }
      gray[dy * cols + dx] = n === 0 ? 0 : sum / n;
    }
  }

  let hex = '';
  for (let y = 0; y < rows; y += 1) {
    let nibble = 0;
    let bits = 0;
    for (let x = 0; x < cols - 1; x += 1) {
      const left = gray[y * cols + x];
      const right = gray[y * cols + x + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/**
 * 图片字节 → 感知哈希。**算不出来返回 `''`（不猜、不退回 md5）**。
 *
 * ## ⚠️ 覆盖范围（如实说，这是本次改动**最大的一个缺口**）
 *
 * 插件是**零依赖、零构建**的，仓库里唯一自带的图片解码器是 `gif.mjs` 的 GIF LZW。
 * ⇒ **只有 GIF 算得出来**；JPEG / PNG / WebP **没有解码器**，一律返回 `''`。
 * 而实测这批语料（`shared\sticker-batch\_state\inventory.json`）是
 * **jpg 1819 / png 307 / gif 118**（共 2244）⇒ **能被哈希的只有 5.3%**。
 *
 * ⇒ 所以这个方法**今天还不是一个能用的去重手段**，它是"纯计算层"的落地：
 * 接口、算法、汉明距离、近似判定都齐了，缺的是"把像素拿到手"这一环。
 * 要真正覆盖全量，有两条路（都**不在本次允许改的文件里**）：
 * ① 给插件加一个解码器（JPEG 最难，PNG 用 `node:zlib` 可行）；
 * ② 让宿主侧（`ctx.attachments` / 宿主图像服务）在存图时顺手给一张缩略图的 RGBA。
 *
 * ## ⚠️ 2026-10-09 实测记下的两件事（都与"帧"有关，但结论和一开始猜的不一样）
 *
 * **① 改成扫多帧挑"覆盖最多"的那一帧**（原实现只解第一帧）。
 *   理由仍然成立：GIF 的帧可以只覆盖画面的一小块（帧间优化）⇒ 第一帧**可能**只是个补丁。
 *   ⚠️ **但我一开始举的那个例子是错的**：我以为留样 `_rerun2/7c3ac6c5….gif` 是"补丁首帧"，
 *   实测它**只有 1 帧、而且整帧不透明（240×240 全覆盖）** ⇒ 那张的问题**不是帧**，见 ②。
 *   ⇒ 多帧扫描**没有实测案例背书**，它只是"比只解第一帧更稳"的防御性改动（代价：GIF 多解几帧）。
 *
 * **② 真问题：近乎纯色的图会退化成"全 0 哈希"**。
 *   `7c3ac6c5` 是一张"白底 + 角落里一个小图案"的图 ⇒ 9×8 降采样之后每个格子都是白的
 *   ⇒ 所有"左>右"都是 false ⇒ **哈希是 `0000000000000000`**。
 *   而**所有近乎纯色的图都会得到同一个全 0 哈希** ⇒ 它们会互相被判成"近似图"
 *   （那会**误丢**一张真表情包）。全 1（`ffff…`）同理。
 *   ⇒ 现在这种**零信息**的哈希**直接返回空串**（当"算不出"处理），
 *     而不是让它去跟别的图"撞"。见下面的 `degenerate` 判断。
 *
 * @param {Uint8Array} data
 * @param {string} [mediaType]
 * @returns {string} 16 个十六进制字符；不是 GIF / 解不开 / 哈希零信息 ⇒ `''`
 */
export function perceptualHashHex(data, mediaType = '') {
  if (!(data instanceof Uint8Array) || data.length === 0) return '';
  if (!isGif(data) && sourceFormatOf(mediaType) !== 'gif') return '';
  let best = null;
  let bestCoverage = -1;
  try {
    decodeGifFrames(data, {
      maxFrames: PHASH_SCAN_FRAMES,
      onFrame: (frame) => {
        // 数"不透明像素"（alpha > 16，容忍压缩噪声）：覆盖最多的那帧最能代表整张图。
        let coverage = 0;
        for (let i = 3; i < frame.rgba.length; i += 4) if (frame.rgba[i] > 16) coverage += 1;
        if (coverage > bestCoverage) {
          bestCoverage = coverage;
          best = frame;
        }
        // 一帧都没覆盖到（全透明）就不用再找了 —— 后面只会更小。
        return bestCoverage !== 0;
      },
    });
    if (best === null || bestCoverage <= 0) return '';
    const hash = perceptualHashRgba(best.rgba, best.width, best.height);
    // ⚠️ **零信息的哈希当"算不出"**：全 0 / 全 1 意味着"每个相邻比较结果都一样"，
    //    也就是这张图在 9×8 的尺度上看不出任何结构（近乎纯色）。
    //    放它过去的话，**所有近乎纯色的图会互相是"近似图"** ⇒ 误丢真表情包。
    if (hash === '' || /^0+$/.test(hash) || /^f+$/.test(hash)) return '';
    return hash;
  } catch {
    // 畸形 GIF 不该把审核带走：算不出就是算不出（`''`），不影响判定。
    return '';
  }
  return hash;
}

/**
 * 两个十六进制哈希的**汉明距离**（不同位的个数）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 距离；两边不是等长非空十六进制串时返回 `-1`（**不可比**，不是 0）
 */
export function hammingDistanceHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return -1;
  if (a === '' || a.length !== b.length) return -1;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number.parseInt(a[i], 16);
    const y = Number.parseInt(b[i], 16);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return -1;
    const z = x ^ y;
    distance += ((z >> 3) & 1) + ((z >> 2) & 1) + ((z >> 1) & 1) + (z & 1);
  }
  return distance;
}

/**
 * 两个哈希是不是"同一张图"（距离 `<= maxDistance`）。
 *
 * ⚠️ **任一边算不出哈希（`''`）就返回 `false`** —— "不知道"不能当成"是同一张"：
 * 那会把每一张 JPEG 都判成彼此的近似图（它们全都是 `''`）。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [maxDistance]
 * @returns {boolean}
 */
export function isNearDuplicate(a, b, maxDistance = DEFAULT_PHASH_MAX_DISTANCE) {
  const d = hammingDistanceHex(a, b);
  if (d < 0) return false;
  return d <= maxDistance;
}

/**
 * 配文：**原样抄**（只收拾成一行，**不截断**）。
 *
 * ⚠️ 刻意**不**走 {@link cleanDescription} —— 那套会剥掉"这张图片显示"这类前缀、
 * 剥掉外层的方括号。对"描述"是对的，对"配文"就是**改证据**：
 * 一条 6 个字的配文被剥成 5 个，`captionChars > captionMaxChars` 这条判据就废了。
 * 这里只做两件事：换行折成空格、去掉首尾空白。
 *
 * ⚠️ **它不截断**，这是 2026-10-09 修的一个真 bug（见 {@link cleanStickerCaption}）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function captionTextOf(raw) {
  return String(raw ?? '')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '').join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 配文的**展示/落盘**形式：和 {@link captionTextOf} 一样，只是**多一步截断**
 * （{@link MAX_STICKER_CAPTION_KEEP}，纯为了日志别被一份几百字的聊天截图淹掉）。
 *
 * ## 🔴 2026-10-09 修掉的 bug：截断**曾经发生在判定之前**
 *
 * 原实现是"先 `cleanStickerCaption`（截到 40 字）→ 再看 `captionChars > captionMaxChars`"。
 * `captionMaxChars` 原来是 5，所以看不出来；这次把它提到 **60** 之后，
 * 这条判据就**永远不可能命中**（真长度先被砍到 40）——
 * 正是一个**死旋钮**：配置里写着 60，日志里一切正常，只是它一次都不会触发。
 *
 * ⇒ 现在判定**用未截断的真长度**（{@link sanitizeStickerVerdict} 里直接调 `captionTextOf`），
 *   这个函数只负责"给人看的那一份"。
 *   ⚠️ 所以 `verdict.captionChars` 可能**大于** `verdict.caption.length` —— 那是刻意的。
 *
 * @param {unknown} raw
 * @returns {string} 最多 {@link MAX_STICKER_CAPTION_KEEP} 个码点
 */
export function cleanStickerCaption(raw) {
  const text = captionTextOf(raw);
  if (text === '') return '';
  const points = Array.from(text);
  return points.length <= MAX_STICKER_CAPTION_KEEP ? text : points.slice(0, MAX_STICKER_CAPTION_KEEP).join('');
}

/**
 * 从模型的回复里**尽量**抠出一个 JSON 对象。
 *
 * 实测模型会三种花样：原样 JSON、套一层 ```json 代码块、前面先寒暄一句。
 * 三种都认；**认不出来就返回 `null`**（不猜、不"尽量解析一半"）——
 * 半解析出来的对象会让 `safe` 变成一个来路不明的值，那比"没看成"危险得多。
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseStickerJson(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const unfenced = s.replace(/^```[A-Za-z]*\s*/, '').replace(/\s*```$/, '').trim();
  const candidates = [unfenced];
  const from = unfenced.indexOf('{');
  const to = unfenced.lastIndexOf('}');
  if (from >= 0 && to > from) candidates.push(unfenced.slice(from, to + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/**
 * 把模型给的 JSON **收拾成契约，并把"收不收"判出来**（纯函数：没有 I/O、没有模型、可单独测）。
 *
 * ⚠️ **判定在代码里做，不信模型自述**（本次改造的核心）。模型只负责
 * `scores`（五项 0-10）和几个客观字段；**收不收由这里拿阈值比出来**。
 *
 * 收拾的几件事：
 * 1. **`caption` / `desc` 过既有的两道护栏**（{@link findJudgementWording}、
 *    {@link isAnimationClaimLabel}）—— 命中就把**那一项**丢掉（不是整条丢：
 *    `desc` 编了不该连带把 `tags` 也废掉）；
 * 2. **`scores` 必须是五个 0-10 的数**，否则整条 `ok:false`（见 {@link normalizeStickerScores}）；
 * 3. ⭐ **`isSticker` / `political` / `pureText` 必须都是真布尔**：任一缺失/非布尔 ⇒
 *    整条 `ok:false`（见 {@link readStickerFlag}，fail-closed）；
 * 4. ⭐ **`captionChars > captionMaxChars` ⇒ 拒**（**唯一可独立复核**的一条，
 *    2026-10-09 起只是**兜底红线**，默认 60）；
 * 5. `political` / `portrait` / `screenshot` 为真 ⇒ 拒；`isSticker !== true` ⇒ 拒；
 *    `pureText` 为真 ⇒ 拒（**都没有阈值**，红线）；
 * 6. 之后才轮到打分 vs 阈值：风险项 **`>=` 就拒**（默认 4 ⇒ 0/1/2/3 收、4 拒）；
 *    ⭐ `funny` **方向相反**：`< funnyMin` 就拒（原因 `boring`）；
 * 7. `tags` 归一化到 17 个枚举（1–3 个），多余/不认识的词进 `unmatched`。
 *
 * `rejects` 会**把所有命中的原因都留下**（按 {@link REJECT_REASONS} 的顺序），
 * `reject` 只报第一个 —— 前者用来事后问"到底哪几条判据在同时拦"，
 * 后者用来做一张按原因分桶的计数表。
 *
 * @param {unknown} raw 模型给的 JSON（或 `parseStickerJson` 的结果）
 * @param {{maxDescChars?: number, gate?: object, phash?: string}} [options]
 *   `phash` 由调用方（{@link createImageDescriber} 的 `describeSticker`）算好传进来 ——
 *   这个纯函数**不做 I/O、不解码图片**，所以它自己不产生哈希，只是把它带进判定结果。
 * @returns {{verdict: object, notes: string[]}}
 */
export function sanitizeStickerVerdict(raw, { maxDescChars = STICKER_DESC_CHARS, gate = null, phash = '' } = {}) {
  const notes = [];
  const g = normalizeStickerGate(gate ?? DEFAULT_STICKER_GATE);
  const failed = () => ({ verdict: failedStickerVerdict(), notes });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    notes.push('not-an-object');
    return failed();
  }
  // 解析出来是个空对象 = 模型什么都没说 ⇒ 同样算"没看成"。
  // ⚠️ 这里查的是**新契约**的字段；旧的 `safe`/`text`/`reject` **刻意不再认**
  //    —— "半认识的旧格式"会让判定变成来路不明的东西，比"没看成"危险得多。
  if (raw.isSticker === undefined && raw.portrait === undefined && raw.screenshot === undefined
    && raw.political === undefined && raw.pureText === undefined
    && raw.scores === undefined && raw.caption === undefined && raw.desc === undefined
    && raw.tags === undefined) {
    notes.push('empty-verdict');
    return failed();
  }
  const target = targetOf(maxDescChars, STICKER_DESC_CHARS);

  // ── caption：配文原样抄；但"给这张图下结论"的话不可能是配文 ──
  // ⚠️ **判定用未截断的真长度**（`captionTextOf`），落盘/日志才用截断过的
  //    `cleanStickerCaption` —— 顺序反过来会让 `captionMaxChars` 变成死旋钮（见那个函数的注释）。
  const captionFull = captionTextOf(raw.caption);
  let captionChars = Array.from(captionFull).length;
  let caption = cleanStickerCaption(raw.caption);
  if (caption !== '' && (findJudgementWording(captionFull) !== null || isAnimationClaimLabel(captionFull))) {
    notes.push('caption-looks-like-judgement');
    caption = '';
    captionChars = 0;
  }

  // ── desc：同样的两道护栏（提示词禁不掉的话，代码里丢掉） ──
  let desc = cleanDescription(raw.desc, descHardLimit(target));
  if (desc !== '' && (findJudgementWording(desc) !== null || isAnimationClaimLabel(desc))) {
    notes.push('desc-looks-like-judgement');
    desc = '';
  }

  // ── tags：1–3 个封闭枚举；选不出来的词只进 unmatched ──
  const normalized = normalizeStickerTags(raw.tags);
  let unmatched = typeof raw.unmatched === 'string' ? raw.unmatched.replace(/\s+/g, ' ').trim() : '';
  if (unmatched === '') unmatched = normalized.unmatched;
  unmatched = Array.from(unmatched).slice(0, MAX_UNMATCHED_CHARS).join('');

  // ── 三个"必须真布尔"的旗标：任一没答 ⇒ **没看成**（fail-closed）──
  //    这张图这次不入库、下次它再出现时重认一遍，比"把风景照/纯文字图当表情包收下"便宜得多。
  const stickerFlag = readStickerFlag(raw.isSticker, 'isSticker', notes);
  if (stickerFlag === null) return failed();
  const politicalFlag = readStickerFlag(raw.political, 'political', notes);
  if (politicalFlag === null) return failed();
  const pureTextFlag = readStickerFlag(raw.pureText, 'pureText', notes);
  if (pureTextFlag === null) return failed();

  // ── scores：五项缺一不可 ──
  const scores = normalizeStickerScores(raw.scores);
  if (scores === null) {
    notes.push('scores-invalid');
    return failed();
  }

  // ── ⭐ 上层判定：代码说了算，顺序就是 REJECT_REASONS 的顺序 ──
  const portrait = raw.portrait === true;
  const screenshot = raw.screenshot === true;
  const political = politicalFlag === true;
  const pureText = pureTextFlag === true;
  const isSticker = stickerFlag === true;
  const rejects = [];
  if (political) rejects.push('political');
  if (portrait) rejects.push('portrait');
  if (screenshot) rejects.push('screenshot');
  if (!isSticker) rejects.push('not-sticker');
  // `text`：主判据是 **pureText（纯文字图）**；`captionChars > captionMaxChars` 只是兜底红线
  // （默认 60 字 = "长到不可能是表情包"）。两者都归到同一个原因名，老日志的 `text` 分桶不断档。
  if (pureText || captionChars > g.captionMaxChars) rejects.push('text');
  // ⭐ `funny` 方向相反：**低于下限**才拒，原因名用 `boring`（读日志时不会误解成"太有趣而拒"）。
  if (scores.funny < g.funnyMin) rejects.push('boring');
  for (const key of STICKER_SCORE_KEYS) {
    if (key === 'funny') continue;   // funny 已在上面按"下限"判过，方向相反，不能掉进这套 `>=`
    if (scores[key] >= g[`${key}Max`]) rejects.push(key);
  }

  return {
    verdict: {
      ok: true,
      accept: rejects.length === 0,
      reject: rejects.length === 0 ? null : rejects[0],
      rejects,
      isSticker,
      portrait,
      screenshot,
      political,
      pureText,
      scores,
      caption,
      captionChars,
      desc,
      tags: normalized.tags,
      unmatched,
      phash: String(phash ?? ''),
    },
    notes,
  };
}

/**
 * 给模型看的「认」指令（一次性出全部字段的 JSON）。
 *
 * ⚠️ **正文来自 toml**（`[sticker_gate] prompt`）。这一层只做一件事：
 * **把占位符填上**。文案一个字都不在代码里 —— 用户点名要求
 * 「表情包入库审核闸需要在 toml 里有一块放提示词的位置」。
 *
 * 四个占位符：`{intro}`（单帧/多帧的开场）、`{descChars}`、`{tags}`、`{banned}`。
 *
 * @param {{frames?: number, maxDescChars?: number, gate?: object}} [options]
 * @returns {string}
 */
export function buildStickerInstruction({ frames = 0, maxDescChars = STICKER_DESC_CHARS, gate = null } = {}) {
  const g = normalizeStickerGate(gate ?? DEFAULT_STICKER_GATE);
  const target = targetOf(maxDescChars, STICKER_DESC_CHARS);
  // 与 describeInstruction 同一条规矩：只说"同一个文件的 N 个画面"（这是事实），
  // **绝不说"这是一张动图"**（那是用户禁掉的说法）。
  const intro = frames > 1
    ? `这是同一个文件里按时间先后取出的 ${frames} 个画面，从左到右排列（不是 ${frames} 张不同的图）。`
    : '这是一张 QQ 表情包。';
  let text = g.prompt.trim() === '' ? DEFAULT_STICKER_PROMPT : g.prompt;
  // ⚠️ 用 split/join 而不是 replaceAll：替换串里以美元符号开头的序列
  //    （美元+&、美元+反引号、美元+单引号…）在 replace/replaceAll 里会被当成
  //    特殊标记展开 —— 而提示词里完全可能出现美元符号。split/join 没有这个陷阱。
  //    ⚠️ 这段注释本身也刻意不写那个符号：`apply-src-edits.mjs` 用的正是
  //    `content.replace(old, new)`，补丁内容里带那种序列会**静默改写整份文件**。
  const fill = (name, value) => { text = text.split(`{${name}}`).join(value); };
  fill('intro', intro);
  fill('descChars', String(target));
  // ⚠️ 2026-10-09：这里原来是 `STICKER_TAGS.join('/')` —— **实测会丢标签**。
  //
  // 批量喂本地 4B（20 张，`shared\tmp\2026-10-09-批量喂本地图-session-00000000.md`）：
  // 模型**照抄分隔符的形状**，回 `"tags":["调侃吐槽/幽默搞笑/无语无奈"]` ——
  // 一个数组元素里塞了三个枚举值。而 {@link normalizeStickerTags} 只认**精确**枚举值
  // （那是它的契约，见 `sticker-tags.mjs`）⇒ 整条进 `unmatched`、标签全丢。
  // 实测：20 张里 3 张这样，而且 **16 张只拿到 1 个标签、0 张拿到 2-3 个** ——
  // 那个斜杠列表被模型当成了"标签的写法"，不是"可选项的清单"。
  //
  // ⇒ 改成**每个值单独用「」括起来、顿号分隔**，并在提示词里把数组格式写死
  //    （见 {@link DEFAULT_STICKER_PROMPT} 的【tags】段，改一处要**两处一起改**：
  //     那份和 `qq-gugu.toml` 的 `[sticker_gate] prompt` 逐字相同，有测试钉着）。
  //   ⚠️ 2026-11-06：`{tags}` 自己会跟着 `STICKER_TAGS` 变（含新增的 `幸灾乐祸`），
  //      所以**可选列表**不需要动 toml；但 `【tags 的语义分界】` 那一段是**新加的正文**，
  //      代码兜底有、线上 toml 还没有（那次改动不许碰 `<DSH_HOME>` 的 toml）。
  // ⚠️ 刻意**不去下游"拆斜杠"**：那要猜"哪些斜杠是分隔符"，是补下游、会引入歧义。
  fill('tags', STICKER_TAGS.map((t) => `「${t}」`).join('、'));
  fill('banned', BANNED_WORDS_IN_PROMPT.join('」「'));
  return text;
}

/**
 * 把模型/QQ 给的文本收拾成**一行描述**。
 *
 * 处理的都是实测里真出现过的东西：换行、首尾引号、外面套的方括号/书名号、
 * 开头的"这张图片显示"这类废话前缀。
 *
 * ⚠️ `maxChars` 这里是**硬上限，切得一刀不剩** —— 不是"目标字数"。
 * "目标 + 余量"那套策略在调用方（`describe` / `describeWithVision`），
 * 它们传进来的是 {@link descHardLimit} 算出来的值。这样这个函数保持纯粹：
 * 说切 N 个就切 N 个，测试里能精确断言。
 *
 * @param {unknown} raw
 * @param {number} [maxChars] **硬**上限（按码点算）
 * @returns {string}
 */
export function cleanDescription(raw, maxChars = DEFAULT_MAX_DESC_CHARS) {
  let text = String(raw ?? '');
  if (text === '') return '';
  // 换行/多段 → 只取第一句有内容的（描述本来就该是一句）
  text = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')[0] ?? '';
  // 去掉套在外面的引号/括号（模型很爱加）
  text = text.replace(/^[「『"'“”‘’\[【(（]+/, '').replace(/[」』"'“”‘’\]】)）]+$/, '');
  // 去掉"这张图片显示/图中是"这类前缀 —— 它不携带信息，纯占字数
  //
  // ⚠️ **但绝不能让整句话被吃光**。实测踩到：描述正好是 `图`（或 `图片`）时，
  // 这条正则把整串都匹配掉了，`cleanDescription('图')` 返回空串 ——
  // 于是一张**有描述**的图被当成"没描述"，退回占位符。
  // 所以剥完若为空，就退回剥之前的样子。
  const withoutPrefix = text.replace(
    /^(这张|该|此)?(图片|图|照片|画面)(里|中|上)?(显示|是|为|有|展示了|呈现的是)?[：:，,]?\s*/,
    '',
  );
  if (withoutPrefix !== '') text = withoutPrefix;
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  // 硬截：按码点切，别把 emoji 的代理对拆成半个
  const points = Array.from(text);
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_DESC_CHARS;
  if (points.length <= limit) return text;
  return points.slice(0, limit).join('');
}

/**
 * 构造一个"图片 → 一句描述"的描述器。
 *
 * @param {object} options
 * @param {{saveImage(input: {data: Uint8Array, mediaType: string, name?: string}): Promise<any>}|null} [options.attachments]
 *   `ctx.attachments`。**没有它就只能走第一级（`summary`）** —— 视觉那级需要把图
 *   存进 DSH 才喂得进去。测试环境没有附件服务，插件照样要能跑。
 * @param {(opts: object) => AsyncIterable<any>} [options.stream] `ctx.llm.stream`
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {(level: string, message: string, meta?: object) => void} [options.log]
 * @param {number} [options.maxChars] **目标**字数（默认 {@link DEFAULT_MAX_DESC_CHARS} = 50）。
 *   ⚠️ 这是目标不是上限：硬截走 {@link descHardLimit}，留 1.5 倍余量。
 *   单次调用可以用 `describe(input, {maxChars})` 覆盖它（表情包传 12）。
 * @param {number} [options.cacheSize]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.botQQ] 小鲸鱼自己的 QQ 号（**从配置读**，用来拼本地原件路径）
 * @param {string[]} [options.originalDirs] 本地原件**目录模板**（`{qq}` / `{yyyy-mm}` / `*`）
 * @param {string} [options.tablePath] 跨会话缓存表路径。
 *   ⚠️ **默认是空串 = 不开表**（不是那个"看起来更方便"的绝对路径）——
 *   模块**不该在没人要求的情况下往用户的磁盘上写全局文件**。
 *   真实部署由 `src/index.mjs` 显式传 `config.imageDescCachePath`（默认值在那儿）。
 *   测试也就不用为了隔离去改一堆调用点。
 * @param {{get: Function, set: Function}|null} [options.table] 直接注入一张表（测试用）
 * @param {object} [options.fsImpl]
 * @param {number} [options.sheetFrames] 多帧 GIF 拼几帧（默认 {@link DEFAULT_SHEET_FRAMES} = 4）
 * @param {object} [options.stickerGate] **审核闸**的参数（真源是 `qq-gugu.toml` 的
 *   `[sticker_gate]`，由 `index.mjs` 的 `loadStickerGate` 读好传进来）。不传 = 用
 *   {@link DEFAULT_STICKER_GATE}。
 *   ⚠️ 这一层**只收已经收拾好的形状** —— 读文件/校验都在 `index.mjs`，
 *   那样 `image-desc.mjs` 完全不用知道 toml 长什么样（和 `proactive` 同样的分层）。
 * @param {Function|null} [options.visionGate] **显存门控的决策函数**
 *   （`vram-gate.mjs` 的 `createVisionGate(...)` 的返回值）。**不传 = 门控关闭**，
 *   行为与 2026-10-08 完全一致（这也是"改 toml 要碰一下 src 才生效"的解法：
 *   接线在代码里，开关在 toml 里）。
 *   传了之后：**没有手动指定 provider/model 的视觉调用**会先问它一次
 *   （空闲显存够 ⇒ 本地，不够 ⇒ 云 https://… 见 `vram-gate.mjs`），
 *   本地失败还会自动退回云。
 * @param {object|null} [options.visionGateConfig] 门控的**参数**（`normalizeVisionGate`
 *   收拾过的形状）。给它是为了让统计快照能报出"本地 provider 配了没有" ——
 *   光看决策函数只能知道"这次选了云"，看不出"是不是因为压根没配本地"。
 * @param {{save: Function, stats: Function}|null} [options.stickerAudit] **审核留样器**
 *   （`sticker-audit.mjs` 的 `createStickerAudit(...)`）。**不传 = 不留样**。
 *   传了之后，「认」的每一次（**含被拒的、没看成的**）都会存一份原图 + 判定 JSON。
 *   为什么必须有它：被拒的图**没有别的落盘机会**（`sticker-library.mjs` 一见
 *   `accept:false` 就丢字节），而用户要当数据标注员校准阈值，缺的正是那批图。
 * @returns {{
 *   describe: (input: Record<string, unknown>, options?: {maxChars?: number}) => Promise<string>,
 *   describeDetailed: (input: Record<string, unknown>, options?: {maxChars?: number}) => Promise<{text: string, source: string}>,
 *   describeAll: (segments: Array<Record<string, unknown>>, options?: {limit?: number, maxChars?: number, withSource?: boolean}) => Promise<Map<string, any>>,
 *   describeSticker: (input: Record<string, unknown>, options?: {maxDescChars?: number, gate?: object}) => Promise<{ok: boolean, accept: boolean, reject: string|null, rejects: string[], isSticker: boolean, portrait: boolean, screenshot: boolean, scores: {nsfw: number, violence: number, gore: number, ugly: number}, caption: string, captionChars: number, desc: string, tags: string[], unmatched: string}>,
 *   canUseVision: () => boolean,
 *   stats: () => object,
 * }}
 */
export function createImageDescriber({
  attachments = null,
  stream = null,
  provider = '',
  model = '',
  log = () => {},
  maxChars = DEFAULT_MAX_DESC_CHARS,
  cacheSize = DEFAULT_CACHE_SIZE,
  fetchImpl = fetch,
  timeoutMs = DESCRIBE_TIMEOUT_MS,
  /**
   * **模型调用**的超时（毫秒，2026-10-13 加）。
   *
   * ⚠️ 它和 `timeoutMs` 是**两件事**，别混：
   * - `timeoutMs` 只管**下图片字节**（`fetchImageBytes`，唯一使用点在下面对 `resolveOriginal`
   *   的调用里）；
   * - 这个管**打模型**（`stream()` 那一整段）。
   *
   * 为什么要加它（用户 2026-10-13 报的"延后"里最毒的一条）：原来模型调用
   * **既没有超时、也没有 `AbortSignal`** —— 提供商挂住就是**无限等**，
   * 而熔断（`image-desc.mjs` 的 `localBroken`）只处理"**抛错**"，
   * 处理不了"**挂住**"（挂住根本不抛）。串行 6 张 ⇒ 一个挂住的请求能把
   * 一整轮回复拖到天荒地老。
   *
   * 超时之后按**普通失败**处理：本地那半 ⇒ 退回云（走既有的 fallback 分支）；
   * 云那半 ⇒ 这张没有描述（`describe` 返回 `''`，渲染退回 `[图片]`）。
   * **绝不编一句**。
   */
  modelTimeoutMs = DESCRIBE_MODEL_TIMEOUT_MS,
  botQQ = '',
  originalDirs = DEFAULT_ORIGINAL_DIRS,
  tablePath = '',
  table = null,
  fsImpl = null,
  sheetFrames = DEFAULT_SHEET_FRAMES,
  stickerGate = null,
  visionGate = null,
  visionGateConfig = null,
  stickerAudit = null,
  // 2026-10-30：图片描述的两套 system（空 / 非字符串 ⇒ 内置原文，行为不变）。
  systemDetailed = '',
  systemBrief = '',
} = {}) {
  /** @type {Map<string, {text: string, source: string}>} 键 → 描述。Map 保持插入顺序，便于淘汰最旧的。 */
  const cache = new Map();
  const stats = {
    hits: 0, local: 0, vision: 0, failed: 0,
    // ↓ 2026-10-07 新增：这几条是回答"本地原件到底找不找得到"的证据（见报告）
    localOriginals: 0, downloaded: 0, tableHits: 0, tableWrites: 0,
    sheets: 0, animationLabels: 0, rejected: 0,
    // ↓ 2026-10-08 新增：「认」（一次调用出全部）的计数
    //  `stickerCalls` 涨而 `stickerFailed` 不涨 ⇒ 这条路是通的；
    //  `stickerAccepted` / `stickerRejected` 是审核闸**真的在判**的证据
    //  （`rejected` 恒为 0 就说明这闸门是个装饰）；
    //  `stickerReasons` **按原因分开记** —— "到底哪条判据在拦"必须能直接看出来，
    //  合成一个总数的话，调阈值就等于闭着眼睛调。
    stickerCalls: 0, stickerFailed: 0, stickerAccepted: 0, stickerRejected: 0,
    //  2026-10-09：加了 `political`（涉政红线）与 `boring`（有趣度不足）两个桶；
    //  `text` 的含义换成了"纯文字图 / 配文超兜底红线"，名字**故意不变** ——
    //  老日志 / 老计数里的 `text` 分桶因此不断档（都是"因为文字而拒"）。
    stickerReasons: {
      political: 0, portrait: 0, screenshot: 0, 'not-sticker': 0, text: 0, boring: 0,
      nsfw: 0, violence: 0, gore: 0, ugly: 0,
    },
    // ↓ 2026-10-09 新增：**显存门控**的计数。
    //   用户要的那个 if「空闲显存 < 7G ⇒ 云，否则本地」到底选了什么、选了几次，
    //   只有这几个数能回答（日志是逐条的，看不出比例）。
    //   ⚠️ `visionGateLast` 是**最近一次的完整决策**（含查到的显存数与判据字符串）——
    //   调阈值的时候，"这一条为什么走了云"必须能直接看出来，否则就是闭着眼睛调。
    visionGate: {
      enabled: false, off: 0, local: 0, cloudLowVram: 0, cloudNoProbe: 0, cloudNoLocal: 0,
      manualOverride: 0, localFailed: 0, localCircuitOpen: 0,
      // 最近一次决策的**完整快照**（见下面 `callVision` 里写它那一段）。
      // 放这里而不是顶层：它和上面那些计数是同一件事的两个面（"选了几次"和"上次为什么"）。
      last: null,
    },
  };

  // 审核闸的**实例级参数**（来自 `qq-gugu.toml` 的 `[sticker_gate]`，由 `index.mjs` 读好传进来）。
  // 单次调用可以用 `describeSticker(input, {gate})` 覆盖它（测试用）。
  const baseGate = normalizeStickerGate(stickerGate ?? DEFAULT_STICKER_GATE);

  // ── 显存门控（2026-10-09）──
  //
  // `visionGate` 是 `vram-gate.mjs` 造出来的那个**决策函数**（`decide(input)`），
  // 由 `index.mjs` 按 toml 的 `[vision_gate]` 造好传进来。
  // ⚠️ **不传 = 门控关闭 = 与 2026-10-08 的行为逐字节相同**（这也是"改 toml 要碰 src"那条的解法：
  //    接线在代码里，开关在 toml 里）。
  const visionGateFn = typeof visionGate === 'function' ? visionGate : null;
  // ⚠️ 本地 provider/model 只有这里能拿到（决策函数返回的 `local` 是**它自己那份**，
  //    而 `index.mjs` 是按 toml 造它的）。优先用 `visionGateConfig`（同一个真源），
  //    没传就退回决策函数自报的配置。
  const gateCfg = normalizeVisionGate(
    visionGateConfig ?? visionGate?.config?.() ?? DEFAULT_VISION_GATE,
  );
  stats.visionGate.enabled = visionGateFn !== null;

  /** 本地连续失败几次就熔断（不再白等一次本地超时）。**只影响本地那半**，云照旧。 */
  const LOCAL_FAILS_BEFORE_OPEN = 3;
  let localFailStreak = 0;
  /** 熔断后为 true：本进程内不再试本地视觉（云是唯一的路）。 */
  let localBroken = false;

  // ── 审核留样（2026-10-09）──
  //
  // `stickerAudit` 是 `sticker-audit.mjs` 造的留样器（对象，带 `save()`）。
  // ⚠️ **不传 = 不留样**，行为与之前完全相同。
  const stickerAuditSink = stickerAudit !== null && typeof stickerAudit?.save === 'function'
    ? stickerAudit
    : null;

  /** 实例级的目标字数（`describe` 的单次 `maxChars` 覆盖它）。 */
  const defaultTarget = targetOf(maxChars, DEFAULT_MAX_DESC_CHARS);

  const finder = createOriginalFinder({
    dirs: originalDirs,
    botQQ,
    log,
    ...(fsImpl === null ? {} : { fsImpl }),
  });

  const descTable = table ?? createDescTable({
    filePath: tablePath,
    log,
    ...(fsImpl === null ? {} : { fsImpl }),
  });

  /**
   * 缓存键 = **图 + 目标字数**。
   *
   * ⚠️ 两个都要，缺一不可：
   * - 少了"图" → 所有图挤在一个键上；
   * - 少了"目标字数" → 同一张图先按 12 字问过、再按 50 字问，会**命中那条 12 字的**，
   *   于是"要长的"永远拿不到长的（而且看不出来，因为缓存命中是静默的）。
   *
   * 对外返回的表仍然用 {@link imageKey} 当键（渲染器按 url/file 查表），
   * 长度只加在**内部缓存**上。
   */
  function cacheKeyFor(key, target) {
    return `${target}\u0000${key}`;
  }

  const canUseVision =
    typeof stream === 'function' &&
    attachments !== null &&
    attachments !== undefined &&
    typeof attachments.saveImage === 'function';

  function remember(key, value) {
    if (key === '' || value.text === '') return;
    cache.set(key, value);
    while (cache.size > Math.max(1, cacheSize)) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  /**
   * 把一张（或一张拼图）喂给多模态模型，拿回**它的原文**。
   *
   * ⚠️ 这里刻意**不解析、不裁剪**：`describeWithVision` 要的是一句描述，
   * `describeStickerWithVision` 要的是一个 JSON —— 两边"怎么收拾"完全不同，
   * 只有"怎么调用"是共用的。这个函数就是那一份共用。
   *
   * @param {{data: Uint8Array, mediaType: string, name?: string}} image
   * @param {{system: string, instruction: string, maxTokens: number, reasoningEffort?: (string|null)}} prompt
   *   `reasoningEffort` 是**这一次调用**的思考档：`'off'`（默认，不给就用它）/ `null` = 明确
   *   **不发这个字段**（让 provider 用默认档 = "思考开"）。⚠️ 它是 DSH LLM 环缝里**唯一**
   *   能表达"要不要思考"的契约字段 —— 别指望塞别的键（适配器会静默丢掉）。
   * @param {(finish: {kind: string}|null) => void} [onFinish] 收下这次调用的**结束原因**
   *   （DSH 的 `StreamChunk` `{type:'finish', reason:{kind}}`）。
   *   ⚠️ 这里**不走返回值**：`callVision` 的契约是"给一段文本"，两个调用方都只关心文本；
   *   把它塞进返回值会把两处调用点都改一遍，而这件事只有「认」需要。
   * @returns {Promise<string>}
   */
  async function callVision(image, { system, instruction, maxTokens, reasoningEffort = 'off', provider: providerOverride = '', model: modelOverride = '' }, onFinish = null) {
    const ref = await attachments.saveImage({
      data: image.data,
      mediaType: image.mediaType,
      name: image.name,
    });

    /**
     * 这一次打算用哪个 provider/model。**三种情形，优先级从高到低**：
     *
     * 1. **调用方显式传了 provider 或 model**（目前只有「认」走 `[sticker_gate]` 的
     *    `provider`/`model`）⇒ **手动配置赢**。理由：那是人写的配置值，
     *    人写了就是"我就要这个"；门控是"没人指定时替我省事"的自动化。
     *    ⚠️ 这条也是**门控的否决权的边界** —— 手动配了本地模型而显存不够时，
     *    门控**不会**把它改成云（那是配置生效，不是自动化该插手的地方）。
     *    代价说清楚：**手动配了本地就没有"本地不可用 ⇒ 回退云"的兜底**，
     *    失败就是失败（`describe` 返回空 → 调用方退回占位符）。
     * 2. **门控开着**（`visionGate` 传进来了）⇒ 问它一次（它自己带几秒缓存）。
     * 3. 都没有 ⇒ 实例级的 `provider`/`model`（老行为，一个字节没变）。
     *
     * 缺一半的覆盖（只传 model 不传 provider）也算"显式"：**缺的那半沿用手动那一侧
     * 的实例值**，而不是混进本地/云的选择 —— 半自动混搭最容易出怪 bug。
     *
     * @returns {Promise<{provider: string, model: string, from: string, fallback: object|null}>}
     */
    async function resolveRoles() {
      const hasOverride = providerOverride !== '' || modelOverride !== '';
      if (hasOverride) {
        stats.visionGate.manualOverride += 1;
        const chosen = {
          provider: providerOverride === '' ? provider : providerOverride,
          model: modelOverride === '' ? model : modelOverride,
          from: 'manual',
          fallback: null,
        };
        log('info', '视觉调用：走【手动指定的】 provider/model（门控不插手）', {
          provider: chosen.provider, model: chosen.model,
          providerFrom: providerOverride === '' ? 'instance' : 'sticker_gate',
          modelFrom: modelOverride === '' ? 'instance' : 'sticker_gate',
        });
        return chosen;
      }

      if (visionGate === null) {
        stats.visionGate.off += 1;
        return { provider, model, from: 'default', fallback: null };
      }

      // 本地那半来自门控配置；实例级 provider/model 只当兜底（不是本地/云的二选一）。
      const decision = await visionGate({ localProvider: gateCfg.local.provider, localModel: gateCfg.local.model });
      stats.visionGate.last = {
        at: new Date().toISOString(),
        use: decision.use,
        reason: decision.reason,
        freeMiB: decision.freeMiB,
        thresholdMiB: decision.thresholdMiB,
        cached: decision.cached,
        ageMs: decision.ageMs,
        provider: decision.provider,
        model: decision.model,
      };
      // 判据 → 计数器（**分开记**：合成一个总数就看不出"为什么走了云"，
      // 而调阈值的时候要的正是那个原因）。
      if (decision.use === 'local') stats.visionGate.local += 1;
      else if (decision.reason === 'vram-low') stats.visionGate.cloudLowVram += 1;
      else if (decision.reason === 'probe-failed') stats.visionGate.cloudNoProbe += 1;
      else stats.visionGate.cloudNoLocal += 1;

      log('info', decision.use === 'local'
        ? '视觉调用：显存够 ⇒ 走【本地】'
        : '视觉调用：走【云】(v4f)', {
        reason: decision.reason,
        freeMiB: decision.freeMiB,
        thresholdMiB: decision.thresholdMiB,
        cached: decision.cached,
        provider: decision.provider,
        model: decision.model,
      });

      // 本地失败 ⇒ 退回云（用户要求：别让"本地优先"变成"没有视觉"）。
      // ⚠️ 只有本地分支才带 fallback；云分支失败就是失败（没有第三条路）。
      const fallback = decision.use === 'local' && decision.cloud.provider !== ''
        ? { provider: decision.cloud.provider, model: decision.cloud.model, reason: decision.reason }
        : null;
      return { provider: decision.provider, model: decision.model, from: decision.use, fallback };
    }

    /**
     * 把 `stream()` 的增量收成整段文本。
     *
     * ⚠️ **`try/catch` 包住 for-await**：流可能在**半路**抛（后端 500、连接断）。
     * 不包的话异常会从这里漏到 `attachments.saveImage` 之后的调用栈上，
     * `callVision` 的调用方虽然也会兜，但那时**已经吐出来的半句**会被丢掉或误用。
     *
     * ⚠️ 2026-10-13：整段被 `withModelTimeout` 包住 + 给 `stream` 传了
     * `signal`（`modelTimeoutMs` 到点即中止）。**在此之前这一段是无限等的** ——
     * 提供商挂住时，`for await` 永远不返回，而熔断只认"抛错"，对"挂住"毫无办法。
     */
    async function streamOnce(useProvider, useModel) {
      // 每次尝试（含本地→云的 fallback）**各有一份自己的控制器与时钟**：
      // 本地那次超时不该把云那次的预算也吃掉。
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const safeAbort = () => {
        try {
          controller?.abort();
        } catch {
          // 已经中止 / 环境不支持 —— 无所谓，计时器那一路照样会把控制权抢回来。
        }
      };
      const chunks = stream({
        provider: useProvider,
        model: useModel,
        // ⭐ 思考档：**这一条就是"关思考"落地的地方**（`[sticker_gate] enableThinking`）。
        //
        // 契约字段只有它：`GenerateOptions.reasoningEffort`。⭐ `null` = **不发这个字段**
        // （= 让 provider 用自己的默认档，通常就是"思考开"）。
        //
        // ⚠️ 为什么不是"往请求体加 `enable_thinking`"：DSH 的 LLM 环缝是**封闭契约**
        //    （`GenerateOptions` 只列了 provider/model/reasoningEffort/messages/system/tools/
        //    temperature/maxTokens/stop/signal/sessionId/purpose），多出来的键**没有**任何
        //    透传通道 —— `dsh-llm-pi-ai` 只读自己认识的那几个字段，`dsh-llm-deepseek` 的
        //    Messages 请求体也是逐字段拼的。所以"塞一个自定义键"只会**静默不生效**。
        //    pi-ai 的 `enable_thinking` 是它**自己**在 `compat.thinkingFormat` 是 qwen 类、
        //    且 `model.reasoning === true` 时按"有没有 effort"生成的 —— 那是 provider 配置的事。
        //    ⚠️ 反过来说：`false`（默认）走的就是**今天这条老路**（`'off'`），
        //    所以加这个旋钮**一个字节的行为都没变**。
        ...(reasoningEffort === null ? {} : { reasoningEffort }),
        // ⚠️ 系统提示词必须跟着用途走：原来写死"**极短**的图片说明"，
        //    那跟"50 字左右"是**对着干**的，模型会照系统提示走。
        system,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: instruction },
          ],
        }],
        // 目标 50 字的中文描述 ≈ 60~90 token，80 会**在句子中间**被截断
        // （看不出来，只会觉得"模型话没说完"）。按目标字数给，留一倍余量。
        maxTokens,
        // ⭐ **中止信号**（2026-10-13）：`signal` 是 `GenerateOptions` 契约里
        //    本来就有的字段（见上面那段"封闭契约"的说明），所以这一条**一定透传得下去**。
        //    `null` 时**不发这个键**（老行为逐字节不变）。
        ...(controller === null ? {} : { signal: controller.signal }),
      });
      let text = '';
      // ⭐ 结束原因：**必须收下来**，否则"被 maxTokens 截断"和"模型就这么答的"
      //    在调用方看起来**完全一样**（两者都只是"回复短了/JSON 半截"）。
      //    `max-tokens` 是 DSH 对 provider `finish_reason:'length'` 的叫法。
      let finish = null;
      try {
        // ⚠️ 两层一起：`signal` 让底层请求到点断，`withModelTimeout` 保证
        //    "流不响应中止、一个 chunk 都不吐"时这一轮也一定会往下走。
        const consume = (async () => {
          for await (const chunk of chunks) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
            else if (chunk?.type === 'finish') finish = chunk.reason ?? null;
          }
        })();
        await withModelTimeout(consume, modelTimeoutMs, safeAbort);
      } catch (error) {
        // 半句话**故意丢掉**（返回空串）：混着本地残句的云回复比"这次没描述"危险得多，
        // 而且 `ok:false` 那条路本来就是 fail-closed。
        // ⚠️ 超时也走这里（`withModelTimeout` 抛的就是普通 Error）⇒ 调用方
        //    按"这张没描述"处理；本地那半还会因此退回云（既有 fallback 分支）。
        //    计时器抢回来的那一刻可能还有一次 `for await` 的收尾失败在飞，
        //    所以这里必须**吞掉它**：`consume.catch(() => {})`。
        void consume.catch(() => {});
        error.partialText = text;
        throw error;
      }
      // ⚠️ 只在**真的产出这次文本**的调用上记它：熔断/回退那几条路会各调一次
      //    `streamOnce`，写在外层的话"先失败的那次"会把它覆盖掉。
      if (onFinish !== null) onFinish(finish);
      return text;
    }

    const chosen = await resolveRoles();

    // ── 熔断：本地连续失败过 ⇒ **这一次连试都不试**，直接用云 ──
    //   为什么要它：本地端点挂了的时候，"每条图消息都白等一次本地超时"会把
    //   一整天每条带图消息都拖慢一个超时。失败 3 次就够了。
    if (chosen.fallback !== null && localBroken) {
      stats.visionGate.localCircuitOpen += 1;
      localFailStreak += 1;
      if (localFailStreak === LOCAL_FAILS_BEFORE_OPEN) {
        log('debug', '本地视觉处于熔断期，本次直接用云', { streak: localFailStreak });
      }
      return await streamOnce(chosen.fallback.provider, chosen.fallback.model);
    }

    try {
      const text = await streamOnce(chosen.provider, chosen.model);
      // 本地成功 ⇒ 连败清零（偶发一次失败不该把本地永久判死）。
      if (chosen.from === 'local') localFailStreak = 0;
      return text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // ── 本地不可用 ⇒ 退回云（端点没起、冷启动超时、500、连接拒…）──
      if (chosen.fallback !== null) {
        stats.visionGate.localFailed += 1;
        localFailStreak += 1;
        if (localFailStreak >= LOCAL_FAILS_BEFORE_OPEN && !localBroken) {
          localBroken = true;
          log('warn', '本地视觉连续失败，**熔断**（本进程后续直接走云，不再白等一次本地超时）', {
            streak: localFailStreak, threshold: LOCAL_FAILS_BEFORE_OPEN, error: detail.slice(0, 200),
          });
        }
        log('warn', '本地视觉调用失败 ⇒ 这一次改走云（v4f）', {
          localProvider: chosen.provider, localModel: chosen.model,
          cloudProvider: chosen.fallback.provider, cloudModel: chosen.fallback.model,
          reason: chosen.fallback.reason,
          error: detail.slice(0, 200),
        });
        // 云成功了 ⇒ 本地那半还是坏的，**不清零**连败（它决定了要不要熔断）。
        return await streamOnce(chosen.fallback.provider, chosen.fallback.model);
      }
      throw error;
    }
  }

  /**
   * 让多模态模型看一眼，只回一句。
   *
   * @param {{data: Uint8Array, mediaType: string, name?: string}} image
   * @param {number} target **目标**字数（硬截按 {@link descHardLimit} 留余量）
   * @param {number} [frames] 传 >1 就是"多帧拼图"
   * @returns {Promise<string>} 失败/不可信返回 `''`
   */
  async function describeWithVision(image, target, frames = 0) {
    const detailed = target >= DETAILED_DESC_MIN;
    // 2026-10-30：两套 system 从 `[vision_gate]` 读（空 / 非字符串 ⇒ 用模块顶部的原文）。
    const sysDetailed = typeof systemDetailed === 'string' && systemDetailed.trim() !== ''
      ? systemDetailed
      : DEFAULT_DESC_SYSTEM_DETAILED;
    const sysBrief = typeof systemBrief === 'string' && systemBrief.trim() !== ''
      ? systemBrief
      : DEFAULT_DESC_SYSTEM_BRIEF;
    const text = await callVision(image, {
      system: detailed ? sysDetailed : sysBrief,
      instruction: describeInstruction(target, { frames }),
      maxTokens: Math.max(80, Math.ceil(target * 2)),
      // ⭐ 2026-11-06：思考档（`[vision_gate] enableThinking`，默认 `false` = 老行为）。
      //    **写法与「认」那条逐字一致**（`describeStickerWithVision` 里的
      //    `reasoningEffort: gate.enableThinking ? null : 'off'`）：
      //    `false`（默认）= `'off'`（= 加这个旋钮之前 `callVision` 的默认参数，一个字节没变）；
      //    `true` = `null` = **不发这个字段**，让 provider 用默认档（通常就是"思考开"）。
      //    ⚠️ `true` 时**不是**发 `reasoningEffort: 'low'`：手写进配置的模型只声明了 `off`，
      //    发别的会直接抛 `UNSUPPORTED_REASONING_EFFORT` ⇒ 只能"不发"。
      //    ⚠️ 它不是 `[sticker_gate] enableThinking`（那个管「认」）—— **两个键、两条路**，
      //    别合并：一个是"转发里那张图配一句话"，一个是表情包审核，预算与用途都不同。
      reasoningEffort: gateCfg.enableThinking ? null : 'off',
    });
    const cleaned = cleanDescription(text, descHardLimit(target));
    // ── 诚实兜底：检到"给这张图下结论"的措辞就整条丢掉 ──
    const bad = findJudgementWording(cleaned);
    if (bad !== null) {
      stats.rejected += 1;
      log('warn', '图片描述里出现了"看不出来"的说法，整条丢弃（退回占位符）', {
        wording: bad,
        frames,
        text: cleaned,
      });
      return '';
    }
    return cleaned;
  }

  /**
   * 取**原件**字节：本地优先（零网络），找不到才下载。
   *
   * 两条路都成立是**刻意的**（用户要求"别赌"）：小鲸鱼账号的 `Pic` 目录今天没落新图
   * （见报告），所以本地这条路**可能长期落空**，必须留着下载那条。
   *
   * @param {Record<string, unknown>} input
   * @returns {Promise<{data: Uint8Array, name: string, via: string, path?: string}|null>}
   */
  async function resolveOriginal(input) {
    const local = finder.find(input);
    if (local !== null) {
      stats.localOriginals += 1;
      log('info', '图片原件用的是本地缓存件（零网络）', {
        via: local.via,
        name: local.name,
        bytes: local.data.length,
      });
      return local;
    }
    const got = await fetchImageBytes(input, {
      fetchImpl,
      timeoutMs,
      ...(fsImpl === null ? {} : { fsImpl }),
    });
    if (got === null) {
      log('debug', '图片原件本地没找到，下载也失败（这张不会有描述）', {
        dirs: finder.dirs(),
        file: String(input?.file ?? ''),
      });
      return null;
    }
    stats.downloaded += 1;
    log('debug', '图片原件本地没找到，改为下载', {
      dirs: finder.dirs(),
      file: String(input?.file ?? ''),
      bytes: got.data.length,
    });
    return { ...got, via: 'download' };
  }

  /**
   * 用**已经拿到的字节**产出一句描述（视觉那一级）。
   *
   * 这里就是"动图看得见动态"落地的地方：GIF 且帧数 > 1 → 挑关键帧拼一张 → 一次调用。
   *
   * @param {Uint8Array} data
   * @param {string} mediaType
   * @param {string} name
   * @param {number} target
   * @returns {Promise<{text: string, source: string, frames: number}>}
   */
  /**
   * 要喂给模型的那张图：多帧 GIF 就先"挑关键帧拼一张"。
   *
   * 抽出来是因为**两条路都要它**（一句描述 / 一次调用出全部的「认」）——
   * 复制一份的话，早晚会有一边忘了抽帧，表现是"动图只看得到第一帧"。
   *
   * @param {Uint8Array} data
   * @param {string} mediaType
   * @param {string} name
   * @returns {{payload: {data: Uint8Array, mediaType: string, name: string}, frames: number, source: string}}
   */
  function prepareVisual(data, mediaType, name) {
    const source = sourceFormatOf(mediaType);
    let frames = 0;
    let payload = { data, mediaType, name };

    if (source === 'gif' && isGif(data)) {
      // 先**数帧**：一帧就是静图（**不抽帧、不拼图、更不说它是动图**）。
      const info = parseGifInfo(data);
      if ((info.frameCount ?? 0) > 1) {
        const sheet = buildGifSheet(data, { maxFrames: sheetFrames });
        if (sheet.ok === true) {
          frames = sheet.picked?.length ?? 0;
          payload = { data: sheet.png, mediaType: 'image/png', name: `${name || 'image'}-sheet.png` };
          stats.sheets += 1;
          // 这一条日志是"动图真的被抽帧了"的证据（帧数/选了哪几帧/拼出来多大）
          log('info', '多帧 GIF：按差异挑了关键帧并拼成一张', {
            frameCount: sheet.frameCount,
            picked: sheet.picked,
            sheet: `${sheet.width}x${sheet.height}`,
            sheetBytes: sheet.png.length,
            avgDiff: Number((sheet.avgDiff ?? 0).toFixed(4)),
          });
        } else {
          log('debug', '多帧 GIF 抽帧失败，退回单帧描述', {
            reason: sheet.reason, frameCount: info.frameCount,
          });
        }
      }
    }
    return { payload, frames, source };
  }

  /**
   * 用**已经拿到的字节**产出一句描述（视觉那一级）。
   *
   * 这里就是"动图看得见动态"落地的地方：GIF 且帧数 > 1 → 挑关键帧拼一张 → 一次调用。
   *
   * @param {Uint8Array} data
   * @param {string} mediaType
   * @param {string} name
   * @param {number} target
   * @returns {Promise<{text: string, source: string, frames: number}>}
   */
  async function describeBytes(data, mediaType, name, target) {
    const prepared = prepareVisual(data, mediaType, name);
    const text = await describeWithVision(prepared.payload, target, prepared.frames);
    return { text, source: prepared.source, frames: prepared.frames };
  }

  /**
   * **「认」：一次调用出全部**（评分 + 配文 + 描述 + 标签），并把"收不收"判出来。
   *
   * 输入与 {@link describeDetailed} 一样（图片段，或已经拿到的字节），
   * 输出是新契约（多一个 `ok`：**"我们真的拿到了判定"**，不是"它安全"；
   * 以及 `accept`：**收不收**，由代码按 `[sticker_gate]` 的阈值算出来）。
   *
   * ⚠️ **永远走视觉**：段里带 `summary` 也照样看图 —— `summary` 是 QQ/NapCat 的
   * **类型标签**（`[动画表情]` 那一类），拿它当"认过了"就是把"没看过"当成"看过了"。
   *
   * ⚠️ **绝不抛异常**：任何一步失败都返回 {@link STICKER_VERDICT_FAILED}
   * （`ok:false` + `accept:false`，fail-closed）。调用方（偷表情包那条路）是
   * fire-and-forget 的，抛出去只会变成一条未捕获的 rejection。
   *
   * ⚠️ **刻意只调一次、不重试** —— 理由见模块注释「`ok:false` 为什么不重试」。
   *
   * @param {Record<string, unknown>} input 图片段 / `{data, mediaType, name}`
   * @param {{maxDescChars?: number, gate?: object}} [options] `gate` 可以覆盖实例级的
   *   `[sticker_gate]`（测试与"临时换一套阈值跑一次"用）
   * @returns {Promise<object>} 见 `createImageDescriber` 的 `@returns`
   */
  async function describeSticker(input, options = {}) {
    const maxDescChars = targetOf(options?.maxDescChars, STICKER_DESC_CHARS);
    const gate = options?.gate === undefined || options?.gate === null
      ? baseGate
      : normalizeStickerGate(options.gate);
    // ⚠️ `source` **不是** `options` 而是 `input`：`sticker-library.mjs` 的
    //    `recognize(image, meta)` 第二个参数就是它（`{chatId, userId, subType}`），
    //    而调用方 `index.mjs` 把它原样并进 `input` 传进来。
    //    它唯一的用途是**留样**（audit）：没有来源，「这张是谁发的」就永远查不出来了。
    const source = input?.source !== null && typeof input?.source === 'object' ? input.source : null;
    if (!canUseVision) {
      stats.stickerFailed += 1;
      log('debug', '「认」没有视觉服务可用（按不可信处理）', {});
      return failedStickerVerdict();
    }
    if (input === null || typeof input !== 'object') return failedStickerVerdict();

    let data = null;
    let mediaType = '';
    let name = '';
    if (input.data instanceof Uint8Array) {
      // 字节已经在手上（偷表情包那条路）—— **不要再下载一次**。
      data = input.data;
      mediaType = typeof input.mediaType === 'string' && input.mediaType !== ''
        ? input.mediaType
        : (sniffImageMediaType(input.data) ?? '');
      name = typeof input.name === 'string' ? input.name : '';
    } else {
      let original = null;
      try {
        original = await resolveOriginal(input);
      } catch (error) {
        stats.stickerFailed += 1;
        log('debug', '「认」取原件出错（按不可信处理）', {
          error: error instanceof Error ? error.message : String(error),
        });
        return failedStickerVerdict();
      }
      if (original === null) {
        stats.stickerFailed += 1;
        return failedStickerVerdict();
      }
      data = original.data;
      name = typeof original.name === 'string' ? original.name : '';
      mediaType = sniffImageMediaType(data) ?? '';
    }
    if (data === null || data.length === 0 || mediaType === '') {
      stats.stickerFailed += 1;
      log('debug', '「认」拿不到能看的字节（按不可信处理）', {});
      return failedStickerVerdict();
    }

    try {
      const prepared = prepareVisual(data, mediaType, name);
      stats.stickerCalls += 1;
      // ⭐ 这次调用**为什么结束**（`max-tokens` = 被预算截断）。见下面那三处用它：
      //    ① warn ② 留样/台账 ③ 结果日志。**别吞掉它** ——
      //    "JSON 被截断"和"模型判它不合格"在结果上长得一模一样，只有它能区分。
      let finish = null;
      const raw = await callVision(prepared.payload, {
        system: '你只输出一个 JSON 对象，不解释、不寒暄、不加 markdown 代码块。',
        instruction: buildStickerInstruction({ frames: prepared.frames, maxDescChars, gate }),
        // ⚠️ **来自 `[sticker_gate] maxTokens`，不再是写死的 420**（默认值仍是 420，行为不变）。
        //    这个数够不够用**取决于模型有没有隐藏思维链**：本地 4B 没有，几百 token 就够；
        //    云端模型会在写 JSON 之前先花掉一大截预算 ⇒ 同一个数会把 JSON 切断。
        //    切断 ⇒ 解析不出对象 ⇒ `ok:false` ⇒ **fail-closed 拒掉**（表现像"模型变严了"）。
        //    ⇒ 换 provider/model 时必须连带看它，靠下面的截断 warn 兜住。
        maxTokens: gate.maxTokens,
        // ⭐ 2026-10-10：思考档（`[sticker_gate] enableThinking`）。
        //    `false`（默认）= `'off'`（= 加这个旋钮之前的老行为，一个字节没变）；
        //    `true` = `null` = **不发这个字段**，让 provider 用默认档。
        //    ⚠️ **这个键只管「认」这一条路**：转发图那句描述（`describeWithVision`）
        //    有**自己的**键（2026-11-06 加的 `[vision_gate] enableThinking`）——
        //    两个键各管一条路、互不影响，别把它们并成一个。
        reasoningEffort: gate.enableThinking ? null : 'off',
        // `[sticker_gate]` 写了 provider/model 就只对这一条审核调用生效。
        provider: gate.provider,
        model: gate.model,
      }, (f) => { finish = f; });
      // ── ⚠️ 被截断必须留痕（**这条是本文件里最容易被吞掉的失败模式**）──
      //
      // 2026-10-10 实测：把审核切到云端 v4f 而沿用 420 时，**20 张里 5 张**
      // 返回 `finish_reason='length'`（它的隐藏思维链实测最高吃到 420）。
      // 后果是 JSON 断在半句 ⇒ 解析失败 ⇒ `ok:false` ⇒ 按不可信拒掉 ——
      // **而当时从结果上完全看不出来**：表现就是"这张图被拒了"，
      // 和"模型判断严格"长得一模一样。（详见 shared\tmp 里的云端对照报告。）
      //
      // ⇒ 所以这里**必须**打一条 warn：它的价值**不是**"修好了什么"，
      //   而是"以后不会再有人被它糊弄"。
      const truncated = finish?.kind === 'max-tokens';
      if (truncated) {
        log('warn', '⚠️ 审核被判「没看成」是因为**回复被 maxTokens 截断**，不是模型判它不合格 —— 这张图的判定不可信，把 [sticker_gate] maxTokens 调大再试', {
          finish: finish?.kind ?? null,
          maxTokens: gate.maxTokens,
          provider: gate.provider === '' ? provider : gate.provider,
          model: gate.model === '' ? model : gate.model,
          frames: prepared.frames,
          mediaType: prepared.payload.mediaType,
          // ⚠️ 这里**经常是空串**，而且空串本身就是结论：实测（2026-10-10，预算 200）
          //    14 条截断里有 13 条的 `reasoning_tokens == max_tokens`、`content` 完全为空 ——
          //    预算是被**隐藏思维链**吃光的，JSON 一个字符都还没开始写（完整回复在留样 json 里）。
          //    只有"已经吐出半截 JSON"那种才是非空的。两种情况都指向同一个结论：**这个数太小**。
          rawTail: String(raw).slice(-160),
        });
      }
      // ⭐ 感知哈希（**纯计算，不调模型**）：用**模型当时真看的那份字节**算 ——
      //    多帧 GIF 是拼好的联络图，单帧就是原图。算不出来（插件没有 JPEG/PNG 解码器）
      //    就是空串，见 {@link perceptualHashHex} 的"覆盖范围"那一节。
      const phash = perceptualHashHex(prepared.payload.data, prepared.payload.mediaType);
      const { verdict, notes } = sanitizeStickerVerdict(parseStickerJson(raw), { maxDescChars, gate, phash });
      // ⚠️ **结束原因要进留样/台账**（2026-10-10 补）：光有一条 warn 是查不到历史的 ——
      //    事后想回答"这批里有多少张是被截断的"，只能靠落盘的字段去筛。
      //    放进 `notes` 是因为那条链（`sticker-audit.mjs`）本来就会把 notes 原样存进
      //    侧车 json + index.jsonl，**不用为了一个新字段去改那个文件的记录结构**。
      if (finish !== null && typeof finish.kind === 'string') {
        notes.push(`finish:${finish.kind}`);
        if (truncated) notes.push('truncated-by-maxTokens');
        // ⚠️ 2026-10-10 补：`finish:error` 只说明"这一次以错误结束"，**说不出错在哪** ——
        //    适配器是在**流里**报的 error（不是抛异常，所以 `onFinish` 照样被调用），
        //    详情全在那个 reason 对象里，之前只留了 `kind` 就把它丢了。
        //    ⇒ 非正常结束时把原始 reason 截一段记下来（留样侧车 + `index.jsonl` 都吃 `notes`），
        //    这样"路由挂错了 / 缺字段 / 鉴权失败"能一眼分辨，不用再去宿主控制台捞。
        //    只在非正常结束时记，正常路径的 note 不变长。
        if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
          let raw = '';
          try { raw = JSON.stringify(finish); } catch { raw = String(finish); }
          notes.push(`finish-raw:${String(raw).slice(0, 400)}`);
        }
      }

      // ── 留样（2026-10-09）：**含被拒的、没看成的** ──
      //
      // 位置就在"判定已经算出来、但还没决定收不收"这一刻 —— 因为 `sticker-library.mjs`
      // 一看到 `accept:false` 就把字节丢了，**被拒的图没有任何别的落盘机会**。
      // 用户要校准阈值，缺的正是那批"被拒但看不到"的图。
      //
      // ⚠️ `save()` **不许影响判定**：它内部全包了（失败只记日志），
      //    这里也不 await 出结果给判定用（`await` 只是为了顺序，拿到的返回值直接丢）。
      // ⚠️ 存的是 `prepared.payload.data` —— **我们交给 DSH 的那份字节**
      //    （多帧 GIF 是拼好的那张联络图，`frames` 也一起记）。
      //    🔴 **2026-10-10 更正**：这句原来写的是"模型当时真看的那些字节"，**不准确** ——
      //    `streamOnce` 交出去的是 `{type:'image', attachment: ref}` 这个**附件引用**，
      //    线上请求体里的图是 DSH 自己 `attachments.readImageRequest()` 生成的**派生副本**
      //    （实测同一张图：留样 47886 B / md5 dcd760e5…，而附件对象是 50758 B 的重编码副本）。
      //    ⇒ **留样证明了"我们手里有图"，不证明"模型看到了图"** —— 这两件事 2026-10-10 真的分岔过：
      //    那次请求里没有可用图，模型照着提示词编了一句很像梗图的话，而留样、判定、入库全都"正常"。
      //    详见 shared\tmp\2026-10-10-审核描述与图不符-session-00000000.md
      if (stickerAuditSink !== null) {
        // ⚠️ **单独包一层 try/catch**：留样是"顺手存一份"，它**绝不许**把判定带走。
        //    实测这就是一个真 bug：不包的话，`save()` 抛出来会被本函数外层那个
        //    catch 接住 ⇒ 整张图变成 `ok:false`（"没看成"）⇒ **不入库**。
        //    即"磁盘满了"会表现成"小鲸鱼不会发表情包了"，而且日志里看起来像模型的问题。
        //    （`sticker-audit.mjs` 自己内部也全包了；这里再兜一层是防"换了个实现忘了包"。）
        try {
          await stickerAuditSink.save({
            data: prepared.payload.data,
            mediaType: prepared.payload.mediaType,
            name: prepared.payload.name ?? name,
            frames: prepared.frames,
            source,
            verdict,
            notes,
            thresholds: {
              nsfwMax: gate.nsfwMax, violenceMax: gate.violenceMax,
              goreMax: gate.goreMax, uglyMax: gate.uglyMax,
              funnyMin: gate.funnyMin,
              captionMaxChars: gate.captionMaxChars,
              // ⚠️ **必须一起记**：事后光看分数和阈值，回答不了"这次是不是被输出预算
              //    截断的" —— 而那个答案随模型变（本地够、云端不够）。
              maxTokens: gate.maxTokens,
              // ⭐ 2026-10-10：这次**有没有关思考**。
              //    ⚠️ 放在 `thresholds` 而不是 `notes` 是**故意的**：`notes` 只进侧车 json，
              //    `thresholds` 同时进侧车 json **和 `index.jsonl` 那一行**（见
              //    `sticker-audit.mjs` 的 `appendIndex`）—— 而"事后拿一行 grep 筛出
              //    '这批关思考了吗'"正是要它落在这儿的原因。
              enableThinking: gate.enableThinking,
            },
          });
        } catch (auditError) {
          log('debug', '留样抛异常（判定不受影响，继续入库/拒绝）', {
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        }
      }
      if (verdict.ok !== true) {
        stats.stickerFailed += 1;
        log('debug', '「认」拿不到完整判定（按不可信处理，不入库；下次它再出现会重认）', {
          raw: String(raw).slice(0, 200),
          notes,
        });
      } else if (verdict.accept) {
        stats.stickerAccepted += 1;
      } else {
        stats.stickerRejected += 1;
        for (const reason of verdict.rejects) {
          if (Object.prototype.hasOwnProperty.call(stats.stickerReasons, reason)) {
            stats.stickerReasons[reason] += 1;
          }
        }
      }
      log('info', '表情包「认」的结果', {
        ok: verdict.ok,
        accept: verdict.accept,
        reject: verdict.reject,
        rejects: verdict.rejects,
        isSticker: verdict.isSticker,
        portrait: verdict.portrait,
        screenshot: verdict.screenshot,
        political: verdict.political,
        pureText: verdict.pureText,
        scores: verdict.scores,
        caption: verdict.caption,
        captionChars: verdict.captionChars,
        desc: verdict.desc,
        tags: verdict.tags,
        unmatched: verdict.unmatched,
        // 感知哈希（空串 = 这个格式算不出来）。它**不参与判定**，只是留给去重那一步。
        phash: verdict.phash,
        // 把当时生效的阈值一起打出来：调阈值的时候，日志里必须能看出"是按哪套比出来的"。
        thresholds: {
          nsfw: gate.nsfwMax, violence: gate.violenceMax, gore: gate.goreMax,
          ugly: gate.uglyMax, funny: gate.funnyMin, caption: gate.captionMaxChars,
          maxTokens: gate.maxTokens,
        },
        // ⭐ 这次"关没关思考"（真源是 `[sticker_gate] enableThinking`）。
        //    逐条日志自己就该能读懂，不用回去翻挂载日志。
        enableThinking: gate.enableThinking,
        // ⭐ 这次调用为什么结束。`max-tokens` ⇒ 上面那条 warn 已经报过，
        //    这里再记一次是为了"逐条日志自己就能读懂"，不用回去翻 warn。
        finish: finish?.kind ?? null,
        truncated,
        frames: prepared.frames,
        source: prepared.source,
        notes,
      });
      return verdict;
    } catch (error) {
      stats.stickerFailed += 1;
      log('warn', '「认」调用失败（按不可信处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failedStickerVerdict();
    }
  }

  /**
   * **输入一张图，输出一句描述 + 它的源格式。**
   *
   * ⚠️ 长度是**按次可指定**的，因为两个调用方要的不一样：
   *
   * ```js
   * await describer.describeDetailed(photoSegment);                    // 图片：默认 50 字上下
   * await describer.describeDetailed(stickerSegment, { maxChars: 12 }); // 表情包：短
   * ```
   *
   * @param {Record<string, unknown>} input
   *   两种都认：
   *   - **OneBot 图片段**：`{url}` / `{file}` / `{base64}`（+ 可选 `summary`）—— 主路径；
   *   - **已下载的字节**：`{data: Uint8Array, mediaType: string, name?: string}` ——
   *     给"图已经在手上"的调用方（比如偷表情包时刚从消息里取到）省一次下载。
   *     ⚠️ 这条路**不看 `summary`**，所以想要"强制走视觉级"就用它。
   * @param {{maxChars?: number}} [options] 本次的**目标**字数；不传用实例默认值
   * @returns {Promise<{text: string, source: string}>} `text` 拿不到就是 `''`（**不抛异常**）
   */
  async function describeDetailed(input, options = {}) {
    if (input === null || typeof input !== 'object') return { text: '', source: '' };
    const target = targetOf(options?.maxChars, defaultTarget);

    // ── 已经给了字节：跳过下载，直接走视觉 ──
    if (input.data instanceof Uint8Array) {
      const mediaType = typeof input.mediaType === 'string' && input.mediaType !== ''
        ? input.mediaType
        : sniffImageMediaType(input.data);
      if (mediaType === null || !canUseVision) return { text: '', source: '' };
      try {
        const got = await describeBytes(input.data, mediaType, input.name, target);
        return { text: got.text, source: got.source };
      } catch (error) {
        stats.failed += 1;
        log('debug', '图片描述失败（按没有描述处理）', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { text: '', source: '' };
      }
    }

    // ── 第一级：QQ 自己给的文本，零成本 ──
    //
    // ⚠️ 两种标签**不算描述**，要落到视觉那级：
    //   1. `[？]`（QQ 也认不出）—— 见 `isUnknownImageLabel`；
    //   2. **`[动画表情]`**（QQ 的**类型**分类，不是画面描述；而且实测 27 张全是 `.jpg`，
    //      根本不可能在动）—— 见 `isAnimationClaimLabel`。这条是小鲸鱼那次误判的**真凶**。
    const label = localImageLabel(input);
    if (isAnimationClaimLabel(label)) {
      stats.animationLabels += 1;
      log('debug', 'QQ 给的是"动画表情"这类**类型**标签，不当作画面描述（改走视觉）', { label });
    }
    const local = (isUnknownImageLabel(label) || isAnimationClaimLabel(label))
      ? ''
      : cleanDescription(label, descHardLimit(target));
    if (local !== '') {
      stats.local += 1;
      return { text: local, source: '' };
    }
    if (!canUseVision) return { text: '', source: '' };

    // ── 内存缓存：同一张图 + 同一个长度，不重复花钱 ──
    const key = imageKey(input);
    const slot = cacheKeyFor(key, target);
    if (key !== '' && cache.has(slot)) {
      stats.hits += 1;
      return cache.get(slot);
    }

    // ── 跨会话表：按段里给的文件名（就是内容 md5）先查一次 —— 命中就**连下载都不用** ──
    //
    // 这个键只有在我们**核对过**「名字 == 内容 md5」之后才会被写进去（见下面写入处），
    // 所以它是可信的；不是"看起来像哈希就信"。
    const nameKey = contentHashNameOf(input);
    if (nameKey !== null) {
      const hit = descTable?.get(`name:${nameKey}`) ?? null;
      if (hit !== null && hit.text !== '') {
        stats.tableHits += 1;
        remember(slot, hit);
        return hit;
      }
    }

    // ── 取原件：本地优先 → 下载 ──
    let original = null;
    try {
      original = await resolveOriginal(input);
    } catch (error) {
      stats.failed += 1;
      log('debug', '取图片原件时出错（按没有描述处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: '', source: '' };
    }
    if (original === null) {
      stats.failed += 1;
      return { text: '', source: '' };
    }

    try {
      const mediaType = sniffImageMediaType(original.data);
      if (mediaType === null) {
        stats.failed += 1;
        return { text: '', source: '' };
      }

      // ── 跨会话表：按**原件的内容哈希**查（主键） ──
      const hash = sha256Hex(original.data);
      const cached = descTable?.get(`sha256:${hash}`) ?? null;
      if (cached !== null && cached.text !== '') {
        stats.tableHits += 1;
        remember(slot, cached);
        return cached;
      }

      const got = await describeBytes(original.data, mediaType, original.name, target);
      if (got.text === '') {
        stats.failed += 1;
        return { text: '', source: got.source };
      }
      stats.vision += 1;
      const value = { text: got.text, source: got.source };
      remember(slot, value);

      // ── 写表 ──
      if (descTable !== null && typeof descTable.set === 'function') {
        const wrote = descTable.set(`sha256:${hash}`, value);
        if (wrote === true) stats.tableWrites += 1;
        // 名字键：**先核对**"段里的文件名 == 这份字节的 md5"再写。
        // 核对不过就不写 —— 宁可少一次零网络命中，也不要拿名字猜内容。
        if (nameKey !== null) {
          const base = nameKey.replace(/\.[a-z0-9]+$/i, '');
          if (md5Hex(original.data) === base) {
            descTable.set(`name:${nameKey}`, value);
          } else {
            log('debug', '文件名不是内容 md5，不写名字键（只用 sha256 那个键）', { name: nameKey });
          }
        }
      }
      return value;
    } catch (error) {
      // 包括 DSH 那边因为尺寸/字节超限而拒收 —— 同样只是"这张没有描述"。
      stats.failed += 1;
      log('debug', '图片描述失败（按没有描述处理）', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: '', source: '' };
    }
  }

  /**
   * **输入一张图，输出一句描述。**
   *
   * @param {Record<string, unknown>} input 见 {@link describeDetailed}
   * @param {{maxChars?: number}} [options]
   * @returns {Promise<string>} 一句描述；拿不到返回 `''`（**不抛异常**）
   */
  async function describe(input, options = {}) {
    return (await describeDetailed(input, options)).text;
  }

  /**
   * 批量：把一组图片段变成 `键 → 描述`，给同步渲染器查表用
   * （`renderRichText` 是纯同步的，异步只在这一层发生）。
   *
   * **失败/超限的图不出现在表里** —— 渲染器查不到就退回原来的占位符，
   * 不会出现"看了但没看见"的空标签。
   *
   * @param {Array<Record<string, unknown>>} segments
   * @param {{limit?: number, maxChars?: number, withSource?: boolean}} [options]
   *   `maxChars` = 这一批的**目标**字数（默认 50 字上下；表情包那批传 12）；
   *   `withSource` = 表里存 `{text, source}` 而不是纯字符串
   *   （渲染器要标 `源 gif` 就需要它；默认 `false` 保持旧契约不变）。
   * @returns {Promise<Map<string, any>>}
   */
  async function describeAll(segments, { limit = DEFAULT_MAX_IMAGES, maxChars, withSource = false } = {}) {
    const out = new Map();
    const list = Array.isArray(segments) ? segments : [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_IMAGES;
    let done = 0;
    for (const seg of list) {
      if (done >= cap) break;
      if (seg === null || typeof seg !== 'object') continue;
      const key = imageKey(seg);
      if (key === '' || out.has(key)) continue;
      done += 1;
      // 串行：并发打模型既容易撞限流，也让"一轮最多几张"这个上限失去意义。
      const got = await describeDetailed(seg, { maxChars });
      if (got.text !== '') out.set(key, withSource ? { text: got.text, source: got.source } : got.text);
    }
    if (out.size > 0) {
      log('info', '给内嵌图片生成描述', { asked: done, got: out.size });
    }
    return out;
  }

  return {
    describe,
    describeDetailed,
    // 「认」（2026-10-08）：一次调用出全部。**与上面两个共用同一条管线**
    // （本地原件 → 多帧拼图 → 一次调用），只是指令换成了那个 JSON 契约。
    describeSticker,
    /**
     * 这个实例**看不看得成图**（有没有 `ctx.llm` + `ctx.attachments`）。
     *
     * `index.mjs` 用它决定要不要把「认」接到偷表情包那条路上：接了就是 fail-closed
     * （认不出 ⇒ 那一张不入库），所以"没有视觉服务"的部署**宁可不接** ——
     * 照样攒图，只是没有标签、也没有审核闸。
     */
    canUseVision: () => canUseVision,
    describeAll,
    stats: () => ({
      ...stats,
      cache: cache.size,
      table: typeof descTable?.stats === 'function' ? descTable.stats() : null,
      dirs: finder.dirs(),
      // 审核闸**当前生效的参数** —— 这是"toml 到底读到了没有 / 用的是哪条 provider"
      // 唯一的直接证据（"配置写了却不生效"是这个项目最贵的一类坑）。
      // ⚠️ 只回长度不回正文：提示词有上千字，塞进调试快照就没人看得下去了。
      stickerGate: {
        provider: baseGate.provider === '' ? provider : baseGate.provider,
        model: baseGate.model === '' ? model : baseGate.model,
        nsfwMax: baseGate.nsfwMax,
        violenceMax: baseGate.violenceMax,
        goreMax: baseGate.goreMax,
        uglyMax: baseGate.uglyMax,
        // ⭐ 2026-10-09：`funny` 的**下限**（唯一一项方向相反的阈值）。
        //    它必须出现在这里 —— 否则"改了这个数到底生效没有"在调试快照里查不到
        //    （而"配置写了却不生效"正是上面那行注释说这个项目最贵的一类坑）。
        funnyMin: baseGate.funnyMin,
        captionMaxChars: baseGate.captionMaxChars,
        // ⭐ 2026-10-10：「认」那一次调用的输出 token 预算。
        //    它必须能在这里直接看见 —— "切了模型却忘了抬这个数"会静默拒掉一部分图，
        //    而现象和"模型变严格了"完全一样（这正是加它那一天踩到的坑）。
        maxTokens: baseGate.maxTokens,
        // ⭐ 2026-10-10：「认」那一次调用**要不要让模型思考**（默认 `false`）。
        //    它必须出现在这里 —— 否则"toml 里写了 enableThinking 到底读到没有"只能翻代码，
        //    而这正是"配置写了却不生效"那一族坑的入口。
        //    ⚠️ 它的线上效果取决于 provider 路由（见 `DEFAULT_STICKER_GATE.enableThinking` 那段）。
        enableThinking: baseGate.enableThinking,
        promptFromToml: baseGate.prompt.trim() !== '',
        // 读到了几个字：光看 promptFromToml 只能证明"非空"，
        // 这个数才能证明**真的读进来一整段**（截断/读错文件都会让它明显偏小）。
        promptChars: Array.from(baseGate.prompt).length,
      },
      // 显存门控**当前生效的参数与状态**（2026-10-09）。
      // ⚠️ 这里是"toml 到底读到了没有"最直接的答案：`enabled:false` = 门控没开，
      //    `local.provider:''` = 本地那半没配 —— 两种都会让 if 永远走云，
      //    而现象看起来完全一样（都只是"走了云"）。所以这两个必须能直接看见。
      visionGate: {
        ...stats.visionGate,
        localProvider: gateCfg.local.provider,
        localModel: gateCfg.local.model,
        cloudProvider: gateCfg.cloud.provider,
        cloudModel: gateCfg.cloud.model,
        thresholdMiB: gateCfg.freeMiB,
        cacheMs: gateCfg.cacheMs,
        // ⭐ 2026-11-06：「图片描述」那次调用**要不要让模型思考**（`[vision_gate] enableThinking`，
        //    默认 `false`）。必须能在这里直接看见 —— 否则"toml 里写了到底读到没有"只能翻代码，
        //    而这正是"配置写了却不生效"那一族坑的入口。
        //    落盘路径：`qq-proactive-debug.json` 的 `imageDesc.visionGate.enableThinking`
        //    （`debug-snapshot.mjs` 的 `imageDescStats` 把这一整块原样搬过去）。
        //    ⚠️ 它和 `stickerGate.enableThinking` 是**两个键**（那条管「认」），别照着改串了。
        //    ⚠️ 线上效果取决于 provider 路由（见 `DEFAULT_VISION_GATE.enableThinking` 那段）。
        enableThinking: gateCfg.enableThinking,
        localCircuitOpen: localBroken,
        localFailStreak,
      },
      // 留样（sticker-audit）的计数：写了几张 / 淘汰了几张 / 目录在哪。
      // ⚠️ `enabled:false` 是"用户关了或没配"；`disabled:true` 是"连续写盘失败自己断开了"——
      //    两者在现象上都是"目录里没东西"，必须分得开。
      stickerAudit: stickerAuditSink === null ? null : stickerAuditSink.stats(),
    }),
  };
}

/** 交给测试与调用方的一个常量（免得它们自己写死 20MB）。 */
export const IMAGE_BYTES_LIMIT = MAX_IMAGE_BYTES;

/** 直接暴露常量，便于文档引用与测试断言"默认目录里没有写死的账号"。 */
export const DEFAULT_DIRS = DEFAULT_ORIGINAL_DIRS;

/** 默认表路径（同上）。 */
export const DEFAULT_TABLE = DEFAULT_DESC_TABLE_PATH;
