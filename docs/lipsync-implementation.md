# 数字人口型同步（Lip Sync）实现文档

> 状态：v1 已联调通过（前端 `feat/talkinghead-lipsync` + 后端 `hologuide_server@feat/lipsync`）
> 更新：2026-06-18
> 关联文档：`lipsync-architecture.md`（架构设计）、`lipsync-final-plan.md`（落地方案）

---

## 1. 一句话概述

服务端在 TTS 断句时把句子文本转成拼音音素（G2P），随 `sentence_start` 下发；
前端按音频播放进度把音素映射成 Oculus 15 视素（viseme）ID，逐帧驱动
TalkingHead 数字人的嘴型，从而绕过 TalkingHead 内置的 MFCC 声学分析，得到
更稳定、与文本对齐的口型。无音素时自动回退到内置 MFCC 路径，保证不退化。

---

## 2. 当前现状（What works today）

已端到端验证通过的链路：

1. **能力协商**：前端 `hello` 携带 `features: { mcp: false, lipsync: true }`，
   后端据此置位 `clientState.LipsyncEnabled = true`。
2. **音素下发**：后端在 `sentence_start` 时对该句做 G2P，`phonemes` 字段随消息下发
   （已验证多音字按上下文取音，如「约」→ `yue`）。
3. **前端驱动**：`useVisemeDriver` 在 `sentence_start` 激活，按播放进度输出 viseme ID，
   经 `streamAudioWithViseme` 喂给 TalkingHead，嘴型跟随音素变化。
4. **优雅回退**：句子无 `phonemes` 字段时，driver 不激活，走 `streamAudio` →
   TalkingHead 内置 MFCC，行为与改造前一致。
5. **打断处理**：文字打断 / `tts stop` 时 `visemeDriver.reset()`，状态干净复位。

> 说明：本地联调时 `vite.config.ts` 的代理 target 指向 `127.0.0.1:8989`（本地 lipsync 后端）。
> 这是**仅本地**的临时改动，**提交前必须改回** `192.168.112.254:8989`，不要把这行切换合入分支。

---

## 3. 架构与数据流

```
┌─────────────────────────── 后端 hologuide_server ───────────────────────────┐
│  hello(features.lipsync) ──► hasLipsyncFeature() ──► clientState.LipsyncEnabled │
│                                                                                │
│  TTS senderLoop ──► handleDelayedSentence(SentenceStart)                        │
│       └─ LipsyncEnabled? ──► lipsync.TextToPhonemes(text)  [go-pinyin, Normal]  │
│                              └─► SendSentenceStart(text, phonemes)              │
└────────────────────────────────────┬───────────────────────────────────────┘
                                      │  WebSocket（Vite dev 经 /xiaozhi 代理）
                                      ▼
┌─────────────────────────────── 前端 xiaozhi-talk-web ──────────────────────────┐
│  useWebSocket  ──► handleMessage(msg)                                           │
│                                                                                 │
│  tts.sentence_start ──► visemeDriver.onSentenceStart(phonemes)                  │
│        └─ phonemesToVisemeIds()  [拼音 → Oculus viseme ID 预转换]                │
│                                                                                 │
│  audio 帧 ──► opus 解码 ──► visemeDriver.isActive ?                              │
│        ├─ 是：streamAudioWithViseme(pcm, visemeDriver.tick())                    │
│        └─ 否：streamAudio(pcm)  ── TalkingHead 内置 MFCC 回退                     │
│                                                                                 │
│  visemeDriver.tick()：按 audioContext.currentTime 推算播放进度 → viseme ID        │
└─────────────────────────────────────────────────────────────────────────────┘
```

协议约定：
- `tts start / stop` 包裹整个 TTS 回合（一次问答的全部句子）。
- `sentence_start / sentence_end` 包裹单句，`phonemes` 只挂在 `sentence_start`。
- 音频帧（`audio`）为 opus 编码，16kHz / 单声道 / 帧时长 60ms。

---

## 4. 代码实现

### 4.1 后端（hologuide_server）

| 位置 | 职责 |
|------|------|
| `internal/data/client/client.go:716` | `Features map[string]bool` 字段，承载 hello 协商能力 |
| `internal/app/server/chat/chat.go:476` | `LipsyncEnabled = hasLipsyncFeature(msg)` 置位 |
| `internal/app/server/chat/chat.go:599` | `hasLipsyncFeature()` 读取 `features.lipsync` |
| `internal/domain/lipsync/lipsync.go` | `TextToPhonemes()`：go-pinyin `Normal` 风格（无声调小写）做 G2P |
| `internal/app/server/chat/tts.go:311` | senderLoop 在 SentenceStart 时按需算音素 |
| `internal/app/server/chat/server_transport.go:203` | `SendSentenceStart(text, phonemes)` 下发 |

G2P 核心（`lipsync.go`）：

```go
func TextToPhonemes(text string) []string {
    if text == "" {
        return []string{}
    }
    args := pinyin.NewArgs()
    args.Style = pinyin.Normal // 无声调小写
    syllables := pinyin.LazyConvert(text, &args)
    out := make([]string, 0, len(syllables))
    for _, s := range syllables {
        if s != "" {
            out = append(out, s)
        }
    }
    return out
}
```

要点：顺序与原文严格对齐；非中文字符被 go-pinyin 默认丢弃；`LazyConvert` 自带
多音字上下文消歧。

### 4.2 前端（xiaozhi-talk-web）

| 文件 | 职责 |
|------|------|
| `src/composables/useWebSocket.ts:85` | hello 发送 `features: { mcp: false, lipsync: true }` |
| `src/types/messages.ts` | `tts` 消息扩展 `phonemes?: string[]` |
| `src/lib/phonemeMap.ts` | 拼音音节 → Oculus 15 viseme ID 的纯函数映射 |
| `src/composables/useVisemeDriver.ts` | 音素 + 播放进度 → 当前帧 viseme ID |
| `src/composables/useTalkingHead.ts` | 封装 TalkingHead，`streamAudioWithViseme` 外部驱动嘴型 |
| `src/composables/useVoiceChat.ts` | 编排层：消息路由、音频解码、driver 激活/回退 |

**① 音素 → viseme 映射（`phonemeMap.ts`）**：以韵母为主决定主嘴型，复合韵母优先匹配
（避免 `ie/in` 被 `i` 抢匹配），纯辅音音节回退到声母，未匹配返回 `0 (sil)`。

```ts
if (/ang|an|ai|ao|a/.test(syllable)) return 8;  // aa
if (/ong|ou|o/.test(syllable))       return 11; // O
if (/eng|en|ei|e/.test(syllable))    return 9;  // E
if (/ing|in|ie|i/.test(syllable))    return 10; // I
if (/un|u|ü|v/.test(syllable))       return 12; // U
// …无元音的极少数情况回退到声母分类（PP/FF/DD/kk/CH/SS…）
```

**② 进度驱动（`useVisemeDriver.ts`）**：`sentence_start` 时预转换音素列表并按经验系数
估算总帧数；首帧音频入队时记录起播 `audioContext.currentTime`，之后每帧按
`(currentTime - startTime)` 推算已播放帧数，得 `progress = framesPlayed / totalFrames`，
取 `visemeIdList[floor(progress × N)]`。

```ts
const FRAME_DURATION_MS = 60;        // 与服务端 frame_duration 对齐
const FRAMES_PER_PHONEME_ZH = 3.5;   // 中文每音节 ≈210ms 的经验系数

// tick()：
const elapsedSec = getCurrentTime() - sentenceStartTime;
const framesPlayed = Math.floor((elapsedSec * 1000) / FRAME_DURATION_MS);
const progress = Math.min(framesPlayed / totalFrames, 1);
const idx = Math.min(Math.floor(progress * visemeIdList.length), visemeIdList.length - 1);
return visemeIdList[idx] ?? VISEME_SIL;
```

**③ 喂给 TalkingHead（`useTalkingHead.ts`）**：通过 `streamAudio` 的
`visemes/vtimes/vdurations` 三元组传入外部 viseme，TalkingHead 即按外部数据驱动嘴型，
不再用内置 MFCC。

```ts
head.streamAudio({
  audio: int16.buffer,
  visemes: [visemeId],
  vtimes: [0],
  vdurations: [durationMs], // 默认 60
});
```

**④ 激活与回退（`useVoiceChat.ts`）**：每个 opus 音频帧解码后，按 driver 是否激活
二选一路由——有音素走 `streamAudioWithViseme`，无音素走 `streamAudio`（内置 MFCC）。

```ts
if (visemeDriver.isActive.value) {
  talkingHead.streamAudioWithViseme(channelData[0], visemeDriver.tick());
} else {
  talkingHead.streamAudio(channelData[0]);
}
```

### 4.3 本次附带修复（commit 666574e）

设置弹窗（魔法棒）原本平铺在页面底部而非居中模态框。根因：`IndexView.vue` 用了
`<ElDialog>` 等组件但**只 import 了样式、未 import 组件本身**，项目也无
`unplugin-vue-components` 自动导入，Vue 把这些标签当未知 HTML 元素，内容直接落到
文档流底部（表现为 DOM 中完全没有 `el-` 前缀类名）。修复为显式 import 组件：

```ts
import { ElDialog, ElInput, ElSelect, ElOption, ElButton } from "element-plus";
```

Playwright 验证：`.el-overlay`（position: fixed）与 `.el-dialog` 正常渲染，弹窗水平居中。

---

## 5. 存在的问题（Known limitations）

### 5.1 时间对齐是估算，非真实音素时长
`totalFrames = phonemes.length × 3.5` 是经验系数，假设每个音节等时长。但真实 TTS 里
音节时长差异很大（停顿、语气词、儿化、数字），单句越长累计漂移越明显。当前靠"单句
2–5 秒、误差肉眼不挑剔"兜底，长句或语速突变时口型会与声音错位。

### 5.2 G2P 精度受限
- **仅中文**：`phonemeMap` 与后端 G2P 只覆盖中文拼音，中英混合 / 纯英文音素会被
  go-pinyin 丢弃，这些片段退回 sil 或无口型。
- **无声调/无音变**：`Normal` 风格丢弃声调，未处理变调、轻声、儿化等音变，嘴型是
  "够用"而非"精确"。

### 5.3 viseme 映射粗糙
映射以韵母为主、用正则按优先级匹配，没有区分介音（如 `ian` 的 i 介音）、复韵母的
口型滑动（`ao` 实际是 a→o 的过渡），一个音节只给一个静态 viseme，缺少协同发音
（coarticulation）的过渡帧，观感偏机械。

### 5.4 进度依赖播放时钟的隐含假设
`tick()` 用 `audioContext.currentTime` 推进度，依赖"音频帧均匀入队且不丢帧"。若网络
抖动导致音频帧成簇到达、或播放被打断重连，`framesPlayed` 与真实声音可能短暂脱节。

### 5.5 句间边界处理保守
`sentence_end` 只重置起播时间、不清空 viseme 列表（为了让最后一帧平稳收尾）。多句
连续播放时，若后一句 `sentence_start` 晚于前一句音频耗尽，可能出现短暂"嘴停在上一句
末尾"的现象。

### 5.6 调试日志仍在生产路径
`useTalkingHead.ts` / `useVoiceChat.ts` 残留多处 `console.log`（viseme 事件、首帧日志
等），按团队规范生产代码不应保留，需在收尾时清理或降级为可开关的 debug 输出。

### 5.7 缺少自动化测试
目前靠 Playwright 手工联调验证，`phonemeMap`（纯函数，最该测）和 `useVisemeDriver`
（可注入时钟、易测）都还没有单元测试，回归只能靠人眼。

---

## 6. 后期优化（Roadmap）

按"投入产出比 + 落地顺序"排列：

1. **音素级时间戳（最高优先级）**
   让 TTS 引擎直接产出每个音素/音节的时间戳（多数 TTS 如 edge-tts、Azure、部分本地
   引擎支持 word/phoneme boundary），后端随 `phonemes` 一并下发 `vtimes/vdurations`，
   前端不再估算总帧数，彻底消除 5.1 的漂移。这是把"够用"提升到"精确"的关键一步。

2. **协同发音过渡帧**
   在相邻 viseme 之间插值/补过渡帧（如 `ao` 给 a→O 的渐变，闭口音 PP 前补一帧合拢），
   嘴型从"跳变"变"滑动"，显著提升自然度。可在 `tick()` 输出层做线性插值。

3. **介音与复韵母细分**
   `phonemeMap` 升级为"声母 + 介音 + 韵腹 + 韵尾"的结构化拆解，而非单正则匹配，
   让 `ian/uang/iao` 这类音节有更准确的主嘴型。

4. **中英混合 / 纯英文支持（v2）**
   后端引入英文 G2P（如 CMU 词典 / g2p-en），前端补 ARPAbet → Oculus viseme 映射，
   覆盖中英混读场景。

5. **声调与音变（可选增强）**
   利用声调微调口型开合度/时长，处理轻声、儿化，进一步贴近真实发音。

6. **健壮性与可观测性**
   - 给 `tick()` 增加丢帧/重连后的进度自校正。
   - 调试日志改为受 `import.meta.env` 或运行时开关控制的 debug 通道，生产默认关闭。

7. **测试补齐**
   - `phonemeMap` 纯函数单测（覆盖各韵母/声母/边界）。
   - `useVisemeDriver` 注入假时钟做进度推进单测。
   - 关键路径 Playwright E2E（断句下发 → 嘴型变化）固化为回归用例。

---

## 7. 设计原理与思路

### 7.1 为什么"服务端 G2P + 前端进度驱动"，而不是纯前端声学分析
TalkingHead 内置 MFCC 方案是从**音频信号**反推嘴型：实时、零依赖文本，但对噪声、
增益、采样率敏感，口型常"抖"且与实际发音对不齐。本方案改从**文本**出发：文本是
TTS 的源头、信息最干净，G2P 在服务端一次算好下发，前端只做"查表 + 对齐进度"，
结果更稳定、更可控，且天然可解释（音素是什么、嘴型就是什么）。

### 7.2 为什么 G2P 放在服务端
- **算力与依赖**：go-pinyin 多音字消歧依赖词库，放服务端避免前端打包词典、减小体积。
- **一致性**：同一份文本的音素只算一次，多端（Web / 未来移动端）共享同一结果。
- **可演进**：后续换更强的 G2P（带时间戳、英文支持）只动服务端，前端协议不变。

### 7.3 为什么选 Oculus 15 viseme 标准
Oculus viseme 是业界通用的口型分类（0–14），TalkingHead 原生支持，GLB 模型的
morph target 也按此命名。选它等于复用整条成熟工具链，不必自定义嘴型集。

### 7.4 为什么用"播放进度"而非"帧计数"驱动
音频在 worklet 里异步播放，主线程拿到的"已入队帧数"不等于"已发声时长"。用
`audioContext.currentTime`（真实播放时钟）算进度，让嘴型跟的是**耳朵听到的声音**，
而不是网络/解码的节奏，这是口型与声音对齐的关键。

### 7.5 为什么保留 MFCC 回退
渐进式、可防御：音素缺失（非中文、G2P 失败、旧后端）时不应黑脸不动嘴。`isActive`
为假即走内置 MFCC，保证"最差也不退化于改造前"，让特性可以安全灰度上线。

### 7.6 设计取舍总结
v1 的核心取舍是**用"够用且稳定"换"快速落地"**：以等时长估算 + 静态 viseme 换取
零额外依赖、最小协议改动、可灰度回退。代价是时间对齐和口型细腻度有上限——这些
正是第 6 节 roadmap 要逐步偿还的技术债，且偿还路径不破坏现有协议与回退机制。

