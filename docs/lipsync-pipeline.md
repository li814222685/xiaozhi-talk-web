# Lip Sync 数据流水线

本文档描述当前生效的 lip sync 实现（feat/talkinghead-lipsync-squashed + feat/lipsync-squashed），按"一句话从 TTS 出声到数字人嘴动"的数据流顺序讲解，每个环节给出关键代码。

## 整体流水线

```
┌─ 后端（hologuide_server）─────────────────────────────────────────────┐
│                                                                       │
│  LLM 句子文本                                                          │
│       ↓                                                                │
│  CosyVoice2 (Triton)                                                  │
│       ↓ 流式 PCM 24kHz                                                │
│  AudioDecoder (重采样 16kHz, 编 Opus)                                 │
│       ↓ Opus frames                                                    │
│  handleStreamTts: 累积整句 Opus 帧 [路径 X 关键]                       │
│       ↓                                                                │
│  computeTimedVisemes:                                                  │
│    Opus → PCM float32 → AlignByEnergyPeaks → []TimedViseme            │
│       ↓                                                                │
│  WS sentence_start { visemes, timedVisemes } 一次性下发                │
│       ↓                                                                │
│  Opus frames 按 Pacing 流出                                            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                            ↓ (WebSocket)
┌─ 前端（xiaozhi-talk-web）─────────────────────────────────────────────┐
│                                                                       │
│  sentence_start → useVisemeDriver.onSentenceStart(timedVisemes)       │
│       ↓                                                                │
│  audio frame (Opus) → useAudioPlayer.play (实际出声)                   │
│       ↓ 同步触发                                                       │
│  useVisemeDriver.tickWithDiag()                                       │
│    用 audioContext.currentTime 查时间表                                │
│       ↓ {shape, intensity}                                            │
│  useTalkingHead.streamAudioWithViseme                                 │
│    setVisemeTarget: 当前 viseme 升起, 其它衰减 50%                     │
│       ↓                                                                │
│  TalkingHead opt.update (每帧):                                        │
│    morph current ← current + (target - current) × 0.35                │
│       ↓                                                                │
│  3D Avatar 嘴动                                                        │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

核心设计取舍：**路径 X** —— 服务端等整句 PCM 收齐后才下发 sentence_start，换来 timedVisemes 精确对齐。代价是首包延迟 +500ms~1s。

---

## 第一步：文本 → viseme 序列（声母 + 韵母）

每个汉字拆成两段："声母 viseme" + "韵母 viseme"，让嘴型节奏接近真实说话的"闭→张→闭→张"。零声母字（如"啊""一"）只输出一段。

**位置**：`hologuide_server/internal/domain/lipsync/lipsync.go`

```go
func TextToVisemes(text string) []string {
    args := pinyin.NewArgs()
    args.Style = pinyin.Normal // 无声调小写

    syllables := pinyin.LazyConvert(text, &args)
    out := make([]string, 0, len(syllables)*2)
    for _, s := range syllables {
        if s == "" {
            continue
        }
        if initial := initialViseme(s); initial != "" {
            out = append(out, initial)
        }
        if vowel := vowelViseme(s); vowel != "" {
            out = append(out, vowel)
        }
    }
    return out
}
```

例子：

| 输入 | 输出 |
|---|---|
| `你好` | `["DD", "I", "kk", "aa"]` |
| `北京` | `["PP", "E", "CH", "I"]` |
| `啊` | `["aa"]`（零声母） |

声母映射规则（节选）：
- `b/p/m` → `PP`（双唇音）
- `f` → `FF`（唇齿音）
- `zh/ch/sh/j/q/x` → `CH`
- `y/w` → 空（半元音过渡，不发独立辅音）

---

## 第二步：累积整句 Opus 帧

CosyVoice2 通过 Triton gRPC 流式产出 24kHz PCM，经 `AudioDecoder` 重采样 + Opus 编码后通过 channel 喂出来。为了能算精确时序，**必须等整句收齐**。

**位置**：`hologuide_server/internal/app/server/chat/tts.go` (`handleStreamTts`)

```go
// 收齐当前 segment 的全部 Opus 帧（路径 X：用 ~500ms~1s 延迟换嘴型对齐）
var opusFrames [][]byte
drained := false
for !drained {
    select {
    case <-item.ctx.Done():
        // ...
    case frame, ok := <-outChan:
        if !ok {
            drained = true
            break
        }
        if !firstAudioReported {
            t.markTtsMetricFirstAudio(item.ctx, item.metricCycle)
            firstAudioReported = true
        }
        frameCopy := make([]byte, len(frame))
        copy(frameCopy, frame)
        opusFrames = append(opusFrames, frameCopy)
    }
}
```

收齐之后才进入 viseme 时序计算。

---

## 第三步：Opus → PCM float32

为了做能量分析，需要把 Opus 解回 PCM。注意：服务端只为分析解一次，最终下发给客户端的还是原始 Opus 帧（不重新编码）。

**位置**：`hologuide_server/internal/util/audio_utils.go`

```go
func OpusFramesToPCMFloat32(opusFrames [][]byte, sampleRate, channels int) ([]float32, error) {
    opusDecoder, err := opus.NewDecoder(sampleRate, channels)
    if err != nil {
        return nil, fmt.Errorf("create opus decoder: %v", err)
    }
    perFrameDuration := 60
    pcmBuffer := make([]int16, channels*sampleRate*perFrameDuration/1000)

    var out []float32
    for _, opusFrame := range opusFrames {
        n, err := opusDecoder.Decode(opusFrame, pcmBuffer)
        // ...
        for i := 0; i < n; i++ {
            out = append(out, float32(pcmBuffer[i])/32768.0)
        }
    }
    return out, nil
}
```

---

## 第四步：能量包络 + 峰值锚点对齐

核心算法。把 PCM 转成 50Hz 能量包络，找到能量峰，再把每个 viseme 锚定到对应的峰。

**位置**：`hologuide_server/internal/domain/lipsync/aligner.go`

### 4.1 算 RMS 能量包络

20ms 不重叠滑窗，得到 50Hz 的能量数组。

```go
func computeRMSEnvelope(pcm []float32, frameSize int) []float32 {
    n := len(pcm) / frameSize
    out := make([]float32, n)
    for i := 0; i < n; i++ {
        var sum float64
        base := i * frameSize
        for j := 0; j < frameSize; j++ {
            s := float64(pcm[base+j])
            sum += s * s
        }
        out[i] = float32(math.Sqrt(sum / float64(frameSize)))
    }
    return out
}
```

### 4.2 找峰

局部极大 + 最小间距（100ms）+ prominence 阈值（峰值 × 15%）。

```go
func findPeaks(env []float32, minDistFrames int, minProminence float32) []int {
    // 严格局部极大
    var cands []cand
    for i := 1; i < len(env)-1; i++ {
        if env[i] > env[i-1] && env[i] >= env[i+1] && env[i] >= minProminence {
            cands = append(cands, cand{i, env[i]})
        }
    }
    // 按高度降序贪心选取，保证最小间距
    sort.Slice(cands, func(i, j int) bool { return cands[i].val > cands[j].val })
    picked := make([]int, 0, len(cands))
    for _, c := range cands {
        ok := true
        for _, p := range picked {
            if abs(c.idx-p) < minDistFrames { ok = false; break }
        }
        if ok { picked = append(picked, c.idx) }
    }
    sort.Ints(picked)
    return picked
}
```

### 4.3 峰与 viseme 对齐

三种情况：

- 峰数 = viseme 数：一一对应
- 峰数 > viseme 数：按时间均匀降采样（不取最高，避免丢句尾低能量字）
- 峰数 < viseme 数：均匀分布锚点 + snap 到 150ms 内最近的峰

```go
// 峰少：均匀分布 + snap 到峰（解决句尾 durMs 退化问题）
const snapWindowMs = 150
snapWindow := snapWindowMs / envelopeFrameMs
for i := 0; i < visemeCount; i++ {
    anchor := (i*envLen + envLen/(2*visemeCount)) / visemeCount
    best := anchor
    bestDist := snapWindow + 1
    for _, p := range peaks {
        d := abs(p - anchor)
        if d < bestDist {
            bestDist = d
            best = p
        }
    }
    out[i] = clampIdx(best, envLen)
}
```

### 4.4 强度（intensity）计算

**关键设计**：辅音 viseme 不能用"自己那一帧的能量"。爆破音/摩擦音能量本就远低于元音，用自己的能量会算出 0.001 这种几乎为 0 的值。改为"取紧邻的元音 intensity × 衰减因子 0.45"。

```go
// 第一遍：先算所有元音的原始 intensity（峰值能量 / 全局最大）
rawIntensities := make([]float32, len(visemes))
for i := range visemes {
    peakIdx := clampIdx(matched[i], len(envelope))
    rawIntensities[i] = envelope[peakIdx] / maxEnergy
}

// 第二遍：辅音用紧邻元音的 intensity 反推
for i := range visemes {
    var intensity float32
    if consonantVisemes[visemes[i]] {
        ref := nearestVowelIntensity(visemes, rawIntensities, i)
        if ref <= 0 {
            ref = 0.5
        }
        intensity = ref * consonantIntensity // 0.45
    } else {
        intensity = rawIntensities[i]
    }
    // ...
}
```

### 4.5 起势点（StartMs）

不用峰值本身做 viseme 开始时刻，而用峰前的能量起涨点（让嘴在"音出来之前"就开始张开）。

```go
func findRisingStart(env []float32, peakIdx int) int {
    searchFrames := risingSearchMs / envelopeFrameMs // 80ms 内
    left := peakIdx - searchFrames
    if left < 0 { left = 0 }
    minIdx := left
    minVal := env[left]
    for i := left; i <= peakIdx; i++ {
        if env[i] < minVal {
            minVal = env[i]
            minIdx = i
        }
    }
    return minIdx
}
```

---

## 第五步：协议下发

`sentence_start` 同时下发 `visemes`（老格式兼容）和 `timedVisemes`（精确时序）。

**位置**：`hologuide_server/internal/data/msg/message_types.go`

```go
type ServerMessage struct {
    Type        string `json:"type"`
    // ...
    Visemes      []string      `json:"visemes,omitempty"`
    TimedVisemes []TimedViseme `json:"timedVisemes,omitempty"`
}

type TimedViseme struct {
    Shape     string  `json:"shape"`
    StartMs   int     `json:"startMs"`
    DurMs     int     `json:"durMs"`
    Intensity float32 `json:"intensity"`
}
```

实际下发数据例：

```json
{
  "type": "tts",
  "state": "sentence_start",
  "text": "祝您生活愉快！",
  "visemes": ["CH","U","DD","I","CH","E","kk","O","U","kk","aa"],
  "timedVisemes": [
    {"shape":"CH","startMs":60,"durMs":20,"intensity":0.44},
    {"shape":"U","startMs":80,"durMs":120,"intensity":0.99},
    {"shape":"DD","startMs":200,"durMs":260,"intensity":0.36},
    ...
  ]
}
```

---

## 第六步：前端按时序调度

前端用 `audioContext.currentTime` 作为时钟，按 elapsedMs 在 TimedViseme 数组里二分找当前 viseme。

**位置**：`xiaozhi-talk-web/src/composables/useVisemeDriver.ts`

```ts
const computeTimed = (): VisemeTickDiag => {
  if (sentenceStartTime === null) {
    sentenceStartTime = deps.getCurrentTime();
  }
  const elapsedMs = (deps.getCurrentTime() - sentenceStartTime) * 1000;

  // 超过总时长后归零，避免句尾嘴卡在最后开口形
  if (elapsedMs >= timedTotalMs + 50) {
    return { viseme: VISEME_SIL, intensity: 0, ... };
  }

  // 找当前 viseme：startMs <= elapsedMs
  let idx = -1;
  for (let i = timedList.length - 1; i >= 0; i--) {
    if (timedList[i].startMs <= elapsedMs) { idx = i; break; }
  }

  const cur = timedList[idx];
  const localProgress = cur.durMs > 0 ? Math.min((elapsedMs - cur.startMs) / cur.durMs, 1) : 1;

  // 强度包络：前 25% 升起、25%~70% 保持、之后衰减到 30%
  let envelope = 1;
  if (localProgress < 0.25) {
    envelope = localProgress / 0.25;
  } else if (localProgress > 0.7) {
    envelope = 1 - ((localProgress - 0.7) / 0.3) * 0.7;
  }

  return {
    viseme: cur.shape,
    intensity: Math.max(0, Math.min(1, cur.intensity * envelope)),
    ...
  };
};
```

每个 viseme 内部还有"前 25% 升起、70% 之后衰减"的包络，让单个 viseme 自己就有起伏。

---

## 第七步：viseme 共存衰减

每个音频帧（约每 60ms）触发一次。设当前 viseme 的 target = intensity，其它 viseme 的 target **按比例 50% 衰减**——而不是直接归零。这样多个 viseme 在切换时短暂共存，模拟真实说话的混合口型。

**位置**：`xiaozhi-talk-web/src/composables/useTalkingHead.ts`

```ts
const DECAY_FACTOR = 0.5;
const setVisemeTarget = (viseme: string, intensity: number) => {
  const clamped = Math.max(0, Math.min(1, intensity));
  if (viseme === "sil" || clamped <= 0.01) {
    for (const name of KNOWN_VISEMES) {
      if (name === "sil") continue;
      const cur = visemeTargets.get(name) ?? 0;
      visemeTargets.set(name, cur * DECAY_FACTOR);
    }
    return;
  }
  for (const name of KNOWN_VISEMES) {
    if (name === "sil") continue;
    if (name === viseme) {
      visemeTargets.set(name, clamped);
    } else {
      // 其它 viseme 按比例衰减，让它们"撑一段"再消失
      const cur = visemeTargets.get(name) ?? 0;
      visemeTargets.set(name, cur * DECAY_FACTOR);
    }
  }
};
```

---

## 第八步：每帧 morph 插值

TalkingHead 的 `opt.update` 回调每帧（按 modelFPS=60）调用一次，做 current → target 的线性插值，最终写入 mesh morph target value。

```ts
(head as any).opt.update = (_dt: number) => {
  const mt = (head as any).mtAvatar;
  for (const name of KNOWN_VISEMES) {
    const target = visemeTargets.get(name) ?? 0;
    const cur = visemeCurrent.get(name) ?? 0;
    if (Math.abs(target - cur) < 0.001 && cur === 0) continue;
    const next = cur + (target - cur) * SMOOTH_FACTOR; // 0.35
    visemeCurrent.set(name, next);
    const key = "viseme_" + name;
    if (mt[key]) {
      mt[key].newvalue = next;
      mt[key].needsUpdate = true;
    }
  }
};
```

`SMOOTH_FACTOR = 0.35` 控制每帧逼近 target 的速度——值大变化快、显得利落，值小变化慢、显得柔和。

---

## 关键设计决策与取舍

### 为什么不在客户端做能量分析

之前版本（已删除）在客户端用 OPUS 解码 + RMS 计算 intensity。问题：

- 客户端音频解码与播放有几十毫秒延迟，能量峰对应的不是"当前应该的口型"
- 每个客户端重复做同样的计算，浪费
- 服务端有完整的句子上下文，能算更准

### 为什么用路径 X（全缓冲再发）而不是边播边发

边播边发延迟低，但 viseme 时序与播放时钟难以精确同步。路径 X 用 500ms~1s 的首包延迟换"嘴型 100% 准"，对话场景下这个延迟感知不强（用户会觉得"对方在思考"）。

### 为什么辅音 intensity 要参考元音

爆破音（PP）/ 摩擦音（FF/SS）的能量天然就比元音低 10~30 倍。直接用包络能量会让辅音 intensity 接近 0，前端把它当 sil 跳过——等于辅音从未出现。改用"紧邻元音 × 0.45"保证辅音有合理的闭嘴幅度。

### 为什么不用 forced alignment（如 WhisperX、MFA）

精度更高，但要部署额外模型，增加 200ms ~ 1s 延迟，且需要 GPU。能量包络 + 峰值锚点是**纯 CPU、毫秒级**的轻量方案，汉语单字单峰的特性让它效果足够好。

### 为什么用 audioContext.currentTime 当时钟

`Date.now()` / `performance.now()` 跟实际播放出来的音频有抖动（音频走的是 worklet 时钟）。`audioContext.currentTime` 是 Web Audio API 的播放时钟，与实际听到的声音同步。

---

## 文件清单

### 后端 `hologuide_server`

| 文件 | 作用 |
|---|---|
| `internal/domain/lipsync/lipsync.go` | TextToVisemes：拼音 → viseme 序列 |
| `internal/domain/lipsync/aligner.go` | AlignByEnergyPeaks：核心对齐算法 |
| `internal/util/audio_utils.go` | OpusFramesToPCMFloat32：Opus 解码工具 |
| `internal/app/server/chat/tts.go` | handleStreamTts/handleDualStreamTts：累积 + 触发对齐 |
| `internal/app/server/chat/server_transport.go` | SendSentenceStart：协议下发 |
| `internal/data/msg/message_types.go` | TimedViseme 传输结构 |

### 前端 `xiaozhi-talk-web`

| 文件 | 作用 |
|---|---|
| `src/types/messages.ts` | TimedViseme TypeScript 类型 |
| `src/composables/useVisemeDriver.ts` | 按 audioContext.currentTime 调度 viseme |
| `src/composables/useTalkingHead.ts` | morph target 写入 + 帧间插值 + 共存衰减 |
| `src/composables/useVoiceChat.ts` | 编排：消息路由 / 音频帧 → driver tick |
| `src/composables/useLipSyncMetrics.ts` | 指标收集（drift、句子档案） |
| `src/components/LipSyncDebugPanel.vue` | 调试面板（实时 viseme、批测） |

---

## 可调参数清单

调嘴型效果的旋钮，按"影响顺序"排：

| 位置 | 参数 | 默认 | 调大 | 调小 |
|---|---|---|---|---|
| `aligner.go` | `consonantIntensity` | 0.45 | 辅音闭嘴更明显 | 辅音几乎看不到 |
| `aligner.go` | `prominenceMinRatio` | 0.15 | 找到的峰更少 | 找到的峰更多 |
| `useTalkingHead.ts` | `SMOOTH_FACTOR` | 0.35 | 切换更利落 | 切换更柔和 |
| `useTalkingHead.ts` | `DECAY_FACTOR` | 0.5 | 旧 viseme 撑更久 | 切换更干净 |
| `useVisemeDriver.ts` | `envelope` 包络曲线 | 25/70 切分 | — | 改曲线形状 |
