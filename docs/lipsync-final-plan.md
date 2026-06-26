# 数字人 Lip Sync 最终落地方案

> 本文是 [lipsync-architecture.md](./lipsync-architecture.md) 全方案梳理之后选定的实施方案。
> 前置文档讨论了 6 条技术路线，本文只描述选定的方案 B（服务端下发音素，前端按播放进度查表）。

## 一、方案概览

```
┌──────────── 服务端 (Go) ────────────┐         ┌────── 前端 ──────┐
│                                    │         │                  │
│  TTS 文本进队                        │         │                  │
│        │                           │         │                  │
│        ▼                           │         │                  │
│  ① lipsync.TextToPhonemes(text)    │         │                  │
│     ├─ 中文段: go-pinyin            │         │                  │
│     └─ 英文段: CMUDict 查表         │         │                  │
│        │                           │  JSON   │                  │
│        ▼                           │         │                  │
│  ["ni","hao","W","ER1","L","D"]    │ ──────▶ │ 存为当前句音素表  │
│        │                           │         │                  │
│        ▼                           │         │  每帧音频:        │
│  SendSentenceStart(text, phonemes) │         │  framesPlayed++   │
│  SendAudioFrame × N                │ ──────▶ │  idx = floor(     │
│                                    │  Opus   │   progress×N)     │
│                                    │         │  → viseme         │
│                                    │         │  → streamAudio    │
└────────────────────────────────────┘         └──────────────────┘
```

### 选型原因（一句话）

服务端只做"文本 → 音素"这一步，业界 TTS 的事实标准链路；时间同步交给前端按"已播放帧数 / 文本估总帧数"查表自然消化。**服务端零额外延迟、零状态、零 sidecar，纯 Go**。

### 工程量

| 模块 | 改动量 |
|------|-------|
| 服务端新增 `internal/domain/lipsync/` 包 | ~150 行（含 CMUDict 嵌入） |
| 服务端协议字段（`message_types.go`） | +1 字段 |
| 服务端调用点（`tts.go`、`server_transport.go`） | ~10 行 |
| 前端 viseme 驱动模块 | ~80 行 |
| 前端 TalkingHead 集成 | 新增一个 composable |

---

## 二、依赖清单

### 服务端

| 依赖 | 用途 | 来源 |
|------|------|------|
| `github.com/mozillazg/go-pinyin` | 中文文本 → 拼音 | 开源（MIT），中文 TTS 生态事实标准 |
| `cmudict.dict` | 英文单词 → ARPAbet 音素 | 开源（BSD），CMU 出品，13 万词，gzip 后 ~150KB，启动时嵌入并解压到 `map[string][]string` |

### 前端

| 依赖 | 用途 | 来源 |
|------|------|------|
| `@met4citizen/talkinghead` | 3D avatar 渲染 + viseme blendshape 驱动 | 开源（MIT） |
| Ready Player Me GLB | avatar 模型，15 个 Oculus viseme morph target | 已有 |

---

## 三、协议设计

### 扩展点：在 `sentence_start` 上加 `phonemes` 字段

```json
{
  "type": "tts",
  "state": "sentence_start",
  "text": "你好 World",
  "session_id": "xxx",
  "phonemes": ["ni", "hao", "W", "ER1", "L", "D"]
}
```

### 字段语义

- `phonemes`：音素序列，**不带时间戳**。中文段用拼音音节（`go-pinyin` 的 `Normal` 风格输出），英文段用 ARPAbet（CMUDict 输出）。两种符号混合存在，由前端映射表统一处理。
- `omitempty`：旧客户端无 `phonemes` 字段照常工作（fallback 到既有 MFCC 方案）。

### 为什么不下发时间戳

- TTS 实际时长受 prompt voice、speed、停顿、情感影响，离线估算偏差 20-40% 是常态。
- 前端用「已播放音频帧数 / 文本估总帧数」查表，时间偏差被天然消化（详见第四节）。
- 协议越精简，跨端越容易复用（Web、Android WebView、Android 原生 Filament 共用一套）。

### Go 结构定义

```go
// internal/data/msg/message_types.go
type ServerMessage struct {
    // ... 已有字段
    Phonemes []string `json:"phonemes,omitempty"`
}
```

---

## 四、前端 viseme 驱动算法

### 核心循环（伪代码）

```typescript
let phonemes: string[] = []
let framesPlayed = 0

// 收到 sentence_start
function onSentenceStart(msg: SentenceStart) {
  phonemes = msg.phonemes ?? []
  framesPlayed = 0
}

// 收到每一帧 60ms 音频
function onAudioFrame(opusFrame: Uint8Array) {
  framesPlayed++

  // 文本估总帧数（经验值，第六节详述）
  const FRAMES_PER_PHONEME = 4   // 60ms × 4 ≈ 240ms / 音素
  const estimatedTotalFrames = Math.max(phonemes.length * FRAMES_PER_PHONEME, 1)

  // 进度归一化到 [0, 1]
  const progress = Math.min(framesPlayed / estimatedTotalFrames, 1)

  // 等分映射到音素索引
  const rawIdx = Math.floor(progress * phonemes.length)
  const idx = Math.min(rawIdx, phonemes.length - 1)

  const phoneme = phonemes[idx] ?? ''
  const visemeId = PHONEME_TO_VISEME[phoneme] ?? 0  // 0 = sil

  // 喂给 TalkingHead
  head.streamAudio({
    audio: pcmFromOpus(opusFrame),
    visemes: [visemeId],
    vtimes: [0],
    vdurations: [60]
  })
}

// 用户打断 / abort
function onAbort() {
  phonemes = []
  framesPlayed = 0
}
```

### `idx` 算法解读

把 0-1 的播放进度，**等分映射到音素数组的索引**。

例：`["ni","hao","shi","jie"]` 4 个音素，整句 17 帧：

```
phonemes:    [  "ni"  ,  "hao" ,  "shi" ,  "jie"  ]
索引：           0         1         2         3
进度区间：    [0.00,0.25)[0.25,0.50)[0.50,0.75)[0.75,1.00]

播放过程（节选）：
  framesPlayed   progress    idx    音素     viseme
       1           0.06       0    "ni"     10 (I)
       4           0.24       0    "ni"     10
       5           0.29       1    "hao"     8 (aa)
       9           0.53       2    "shi"    14 (CH)
      13           0.76       3    "jie"     9 (E)
      17           1.00       3*   "jie"     9   *夹紧到 length-1
```

### 为什么不漂移

| 场景 | 行为 |
|------|------|
| 网络卡顿 5 秒 | 没新帧 → framesPlayed 不动 → viseme 不动（嘴跟音频一起停） |
| 网络恢复一次性追 20 帧 | framesPlayed 跳 +20 → viseme 同步快进 |
| 用户打断 | abort → 清空 phonemes → 嘴回 sil（静默） |
| 服务端估时长偏 30% | 某个音素比理想晚/早一两帧 → 人眼无感 |

**核心保证：viseme 永远跟"嘴里出声的那一帧"绑定，不跟时钟绑定。**

---

## 五、音素 → Viseme 映射表

### Oculus 15 个 viseme（标准）

| ID | 名称 | 对应发音 |
|----|------|----------|
| 0 | viseme_sil | 静默 |
| 1 | viseme_PP | b/p/m（双唇闭合） |
| 2 | viseme_FF | f/v（唇齿） |
| 3 | viseme_TH | th（齿间，中文无） |
| 4 | viseme_DD | d/t/n/l（舌尖抵齿龈） |
| 5 | viseme_kk | g/k/h（舌根） |
| 6 | viseme_nn | n/ng（鼻音） |
| 7 | viseme_RR | r（卷舌） |
| 8 | viseme_aa | a 类元音 |
| 9 | viseme_E | e 类元音 |
| 10 | viseme_I | i 类元音 |
| 11 | viseme_O | o 类元音 |
| 12 | viseme_U | u 类元音 |
| 13 | viseme_SS | s/z/c（舌尖平） |
| 14 | viseme_CH | sh/ch/zh/j/q/x（舌面/舌尖后） |

### 中文拼音映射策略

**v1 简化策略**：拼音整音节查表，按韵母为主映射（声母时间短，对嘴型贡献小，韵母决定主要嘴型）。

```typescript
// 韵母为主的映射规则（自动派生，无需逐音节列举）
function pinyinToViseme(syllable: string): number {
  // 1) 检测元音核心
  if (/a/.test(syllable))  return 8   // aa
  if (/o/.test(syllable))  return 11  // O
  if (/[eê]/.test(syllable)) return 9 // E
  if (/i$|ie|in|ing/.test(syllable)) return 10  // I
  if (/u|ü/.test(syllable)) return 12 // U
  // 2) 纯辅音（罕见，如儿化音）
  if (/^[bpm]/.test(syllable)) return 1
  if (/^f/.test(syllable))     return 2
  if (/^[dtnl]/.test(syllable)) return 4
  if (/^[gkh]/.test(syllable)) return 5
  if (/^[jqx]/.test(syllable)) return 14
  if (/^(zh|ch|sh)/.test(syllable)) return 14
  if (/^r/.test(syllable))     return 7
  if (/^[zcs]/.test(syllable)) return 13
  return 0  // sil
}
```

> v2 优化项：拆声母 + 韵母为两个 viseme，按 0.3 / 0.7 权重切换，嘴型更细腻。但 v1 整音节查表已经足够好。

### 英文 ARPAbet 映射

CMUDict 的 ARPAbet 含重音标记（`AA1`、`IY0`），映射时去掉数字尾缀。

```typescript
const ARPABET_TO_VISEME: Record<string, number> = {
  // 元音
  'AA': 8, 'AE': 8, 'AH': 8, 'AO': 11, 'AW': 8, 'AY': 8,
  'EH': 9, 'ER': 7, 'EY': 9,
  'IH': 10, 'IY': 10,
  'OW': 11, 'OY': 11,
  'UH': 12, 'UW': 12,
  // 辅音
  'B': 1, 'P': 1, 'M': 1,
  'F': 2, 'V': 2,
  'TH': 3, 'DH': 3,
  'D': 4, 'T': 4, 'N': 4, 'L': 4,
  'G': 5, 'K': 5,
  'NG': 6,
  'R': 7,
  'S': 13, 'Z': 13,
  'SH': 14, 'ZH': 14, 'CH': 14, 'JH': 14,
  'HH': 5,
  'W': 12, 'Y': 10,
}

function arpabetToViseme(phoneme: string): number {
  const stripped = phoneme.replace(/[0-9]/g, '')  // "AA1" → "AA"
  return ARPABET_TO_VISEME[stripped] ?? 0
}
```

### 统一入口

```typescript
function phonemeToViseme(p: string): number {
  // ARPAbet 是大写，拼音是小写 → 用大小写区分
  if (/[A-Z]/.test(p)) return arpabetToViseme(p)
  return pinyinToViseme(p)
}
```

---

## 六、服务端实现细节

### 包结构

```
internal/domain/lipsync/
├── lipsync.go        # 入口：TextToPhonemes(text) []string
├── pinyin_zh.go      # 中文：go-pinyin 包装
├── cmudict_en.go     # 英文：CMUDict 加载与查询
├── lang_split.go     # 中英混合切段
├── cmudict.dict.gz   # 嵌入资源
└── lipsync_test.go
```

### 主入口

```go
package lipsync

import (
    "strings"
    "github.com/mozillazg/go-pinyin"
)

// TextToPhonemes 将文本转为音素序列
// 中文段输出拼音（小写，无声调），英文段输出 ARPAbet（大写，含重音数字）
func TextToPhonemes(text string) []string {
    out := []string{}
    for _, seg := range splitByLang(text) {
        switch seg.Lang {
        case LangZh:
            args := pinyin.NewArgs()
            args.Style = pinyin.Normal
            for _, syll := range pinyin.LazyConvert(seg.Text, &args) {
                if syll != "" {
                    out = append(out, syll)
                }
            }
        case LangEn:
            for _, word := range strings.Fields(seg.Text) {
                phs := cmudictLookup(strings.ToUpper(word))
                if len(phs) == 0 {
                    phs = fallbackEn(word)  // 退化为字母级映射
                }
                out = append(out, phs...)
            }
        }
    }
    return out
}
```

### 中英文切段（lang_split.go）

```go
type LangSeg struct {
    Lang string  // "zh" / "en"
    Text string
}

const (
    LangZh = "zh"
    LangEn = "en"
)

// splitByLang 按 ASCII / 中文 unicode 边界切段
// "你好 World" → [{zh,"你好"}, {en,"World"}]
func splitByLang(text string) []LangSeg {
    // 实现：遍历 rune，遇到中英切换就开新段
    // 标点和数字归到相邻段
}
```

### CMUDict 加载（cmudict_en.go）

```go
package lipsync

import (
    _ "embed"
    "compress/gzip"
    "bytes"
    "bufio"
    "strings"
    "sync"
)

//go:embed cmudict.dict.gz
var cmudictGz []byte

var (
    cmudict     map[string][]string
    cmudictOnce sync.Once
)

func ensureCMUDict() {
    cmudictOnce.Do(func() {
        cmudict = make(map[string][]string, 130000)
        gr, _ := gzip.NewReader(bytes.NewReader(cmudictGz))
        defer gr.Close()
        scanner := bufio.NewScanner(gr)
        for scanner.Scan() {
            line := scanner.Text()
            if strings.HasPrefix(line, ";;;") || line == "" {
                continue
            }
            // 格式：WORD  PH1 PH2 PH3
            parts := strings.Fields(line)
            if len(parts) < 2 {
                continue
            }
            word := parts[0]
            // 多音词标记：WORD(2) → 取第一个
            if idx := strings.Index(word, "("); idx > 0 {
                continue
            }
            cmudict[word] = parts[1:]
        }
    })
}

func cmudictLookup(word string) []string {
    ensureCMUDict()
    return cmudict[word]
}

// fallbackEn 词典未命中时按字母粗略发音（极少见，覆盖生造词）
func fallbackEn(word string) []string {
    // 简化：每个字母映射一个 ARPAbet
    // 这是兜底逻辑，实际生产中 CMUDict 13 万词覆盖率 > 99%
}
```

### 调用点改造

只改两个文件：

**`internal/data/msg/message_types.go`** —— 加一个字段：

```go
type ServerMessage struct {
    // ... 已有字段
    Phonemes []string `json:"phonemes,omitempty"`
}
```

**`internal/app/server/chat/server_transport.go:203`** —— 接收并附带 phonemes：

```go
func (s *ServerTransport) SendSentenceStart(text string, phonemes []string) error {
    response := ServerMessage{
        Type:      ServerMessageTypeTts,
        State:     MessageStateSentenceStart,
        Text:      text,
        SessionID: s.clientState.SessionID,
        Phonemes:  phonemes,
    }
    // ... 其余逻辑不变
}
```

**`internal/app/server/chat/tts.go:209`** —— 在调用前算一次音素：

```go
case AudioQueueKindSentenceStart:
    if elem.OnStart != nil {
        elem.OnStart()
    }
    if elem.Text != "" {
        phonemes := lipsync.TextToPhonemes(elem.Text)
        if err := t.serverTransport.SendSentenceStart(elem.Text, phonemes); err != nil {
            // ...
        }
    }
```

> 注：调用 `SendSentenceStart` 的位置只有这一处，不存在多处兼容性问题。

---

## 七、前端实现细节

### 模块结构

```
src/composables/
├── useTalkingHead.ts        # 新增：TalkingHead 实例 + GLB 加载
├── useVisemeDriver.ts       # 新增：phonemes → idx → viseme → streamAudio
└── useVoiceChat.ts          # 改造：onSentenceStart / onAudioFrame 接入 driver

src/lib/
└── phonemeMap.ts            # 新增：拼音 + ARPAbet 映射表
```

### TalkingHead 集成（useTalkingHead.ts）

```typescript
import { TalkingHead } from '@met4citizen/talkinghead'

export function useTalkingHead(canvas: HTMLElement, glbUrl: string) {
  const head = new TalkingHead(canvas, {
    ttsEndpoint: '',  // 不用内置 TTS
    cameraView: 'upper',
  })

  await head.showAvatar({
    url: glbUrl,
    body: 'F',
    avatarMood: 'neutral',
  })

  return head
}
```

### viseme 驱动（useVisemeDriver.ts）

```typescript
import { phonemeToViseme } from '@/lib/phonemeMap'

const FRAMES_PER_PHONEME = 4

export function useVisemeDriver(head: TalkingHead) {
  let phonemes: string[] = []
  let framesPlayed = 0

  function reset(newPhonemes: string[] = []) {
    phonemes = newPhonemes
    framesPlayed = 0
  }

  function onFrame(pcmBuffer: Int16Array) {
    framesPlayed++

    const total = Math.max(phonemes.length * FRAMES_PER_PHONEME, 1)
    const progress = Math.min(framesPlayed / total, 1)
    const idx = Math.min(
      Math.floor(progress * phonemes.length),
      phonemes.length - 1
    )

    const visemeId = phonemes.length
      ? phonemeToViseme(phonemes[idx] ?? '')
      : 0

    head.streamAudio({
      audio: pcmBuffer,
      visemes: [visemeId],
      vtimes: [0],
      vdurations: [60],
    })
  }

  return { reset, onFrame }
}
```

### 接入既有 useVoiceChat.ts

伪代码层级，定位 sentence_start / audio frame 处理点：

```typescript
const driver = useVisemeDriver(head)

ws.on('message', (msg) => {
  if (msg.type === 'tts' && msg.state === 'sentence_start') {
    driver.reset(msg.phonemes)
  } else if (msg.type === 'tts' && msg.state === 'stop') {
    driver.reset()
  }
})

opusDecoder.on('pcm', (pcmBuffer) => {
  driver.onFrame(pcmBuffer)
})
```

---

## 八、Android 端策略

### v1：WebView 复用 Web 端实现

零额外工作。Android 起一个 WebView 加载 Web 页面即可。中英 5:5 场景下推荐这个。

### v2（按需）：Filament 原生

如果对性能/启动速度有要求，把以下三块翻译成 Kotlin：

1. `phonemeMap.ts` → `PhonemeMap.kt`（30 行映射表 + 切分函数）
2. `useVisemeDriver.ts` 的算法 → `VisemeDriver.kt`（~50 行）
3. GLB morph target 调用：`modelInstance.setMorphWeight("viseme_${NAMES[id]}", 1.0)`

协议（`phonemes` 字段）完全复用，无需服务端改动。

---

## 九、实施计划

### Phase 1：服务端 + 协议（1 天）

- [ ] 新建 `internal/domain/lipsync/` 包
- [ ] 嵌入 CMUDict（去 [github.com/cmusphinx/cmudict](https://github.com/cmusphinx/cmudict) 取 `cmudict.dict`，gzip 后嵌入）
- [ ] 实现 `TextToPhonemes(text)`
- [ ] 写单测：覆盖纯中文 / 纯英文 / 中英混合 / 特殊字符
- [ ] 改 `message_types.go` 加 `Phonemes` 字段
- [ ] 改 `server_transport.go` 和 `tts.go` 调用点
- [ ] 端到端：抓 WebSocket 报文，确认 `sentence_start` 带 phonemes

### Phase 2：前端 viseme 驱动（1 天）

- [ ] 安装 `@met4citizen/talkinghead`，准备 Ready Player Me GLB（已有可跳过）
- [ ] 写 `phonemeMap.ts`
- [ ] 写 `useTalkingHead.ts`、`useVisemeDriver.ts`
- [ ] 接入 `useVoiceChat.ts`
- [ ] 浏览器实测：中文短句、英文短句、中英混合长句

### Phase 3：体验调优（按需）

- [ ] `FRAMES_PER_PHONEME` 经验值实测后调整（中文实际 ~3.5, 英文 ~5）
- [ ] 视觉问题：录屏对比，确认嘴型序列正确
- [ ] 边界场景：长句（>30 字）、纯标点、用户打断、网络抖动

### Phase 4（v2）：精度升级（长期）

- [ ] 拼音拆声母 + 韵母双 viseme
- [ ] sentence_end 时按真实总帧数回算修正
- [ ] 多音字 → 引入 g2pM/g2pW Python sidecar 解决

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| `FRAMES_PER_PHONEME` 经验值不准 | 嘴型节奏偏快或偏慢 | sentence_end 后用真实总帧数校准（v2） |
| CMUDict 不在词典的生造词（"chatgpt"、"xiaozhi"） | 该词回 sil | 字母级 fallback；持续维护 user_dict |
| 中文多音字（"行" háng/xíng） | 个别字 viseme 错 | go-pinyin 默认取常用音；v2 上 g2pM 解决 |
| 整音节映射粒度粗 | 嘴型不够生动 | v2 拆声母韵母 |
| TalkingHead npm 包停止维护 | 长期风险 | 该库 MIT 协议，必要时可 fork；接口面小，替换成本可控 |
| Android 低端机 WebGL 性能 | 帧率下降 | 提供 2D 静态图片降级开关 |

---

## 十一、和原方案文档的差异

[lipsync-architecture.md](./lipsync-architecture.md) 列了 6 个方向：纯规则、espeak-ng、MFA/CTC、换 TTS、改 CosyVoice2、Go port MFCC。
本最终方案选择了**比原推荐路径（espeak-ng）更简化的版本**，关键差异：

| 维度 | 原推荐（espeak-ng） | 最终方案（go-pinyin + CMUDict） |
|------|---------------------|---------------------------|
| G2P 中文质量 | espeak 内置规则 | go-pinyin（CosyVoice 同款） |
| G2P 英文质量 | espeak 规则 | CMUDict 词典查表（业界标准） |
| 部署依赖 | espeak-ng 二进制 + 多语言数据 | 0（纯 Go） |
| 子进程开销 | 每句几十 ms | 0 |
| 时间精度 | 服务端预测毫秒，前端缩放 | 前端按播放进度查表，无需预测 |
| 协议字段 | `visemes: [{id,t,d,w}]` 复杂结构 | `phonemes: ["ni","hao"]` 字符串数组 |
| viseme 映射归属 | 服务端做 | 前端做（多端切换 morph 标准更灵活） |

**核心简化**：把"viseme 时间预测"这个最难的问题，用"前端按已播放进度查表"绕过去。
