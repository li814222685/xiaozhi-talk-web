# 数字人 Lip Sync 全方案梳理

## 一、背景与目标

### 项目现状

- **产品**：xiaozhi 智能语音助手，支持 Web 端和 Android 端
- **TTS 引擎**：CosyVoice2（Triton 部署，16kHz Opus 流）
- **服务端**：Go（hologuide_server），WebSocket 下发 TTS 控制消息 + 音频帧
- **前端**：Vue 3 + TalkingHead（@met4citizen/talkinghead），3D avatar（Ready Player Me GLB，15 个 Oculus viseme morph target）
- **当前 lip sync**：前端基于 HeadAudio 的 MFCC 频谱分析实时生成 viseme

### 核心问题

前端频谱分析方案存在本质缺陷：
1. **序列不准** — 只看频谱形状，不知道在发什么音。频谱相似的不同音素映射到同一 viseme
2. **中文适配差** — 训练模型是英语语料（model-en-mixed.bin），中文音素映射偏差大
3. **双重平滑** — HeadAudio sigmoid(100ms) + TalkingHead 指数平滑(acc=0.01) 叠加，快速语音口型跟不上

### 目标

将 viseme 推理从前端移到服务端，实现：
- 口型序列正确（知道在发什么音）
- 与音频播放同步（不漂移、不超前）
- 中英文通用
- Web 和 Android 统一方案

---

## 二、技术基础

### Oculus Viseme 标准（15 个）

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

### 中文音素→Viseme 映射

| 声母 | Viseme ID |
|------|-----------|
| b, p, m | 1 (PP) |
| f | 2 (FF) |
| d, t, n, l | 4 (DD) |
| g, k, h | 5 (kk) |
| j, q, x | 14 (CH) |
| zh, ch, sh | 14 (CH) |
| r | 7 (RR) |
| z, c, s | 13 (SS) |

| 韵母 | Viseme ID |
|------|-----------|
| a, ai, ao, an, ang | 8 (aa) |
| e, ei, en, eng | 9 (E) |
| i, in, ing | 10 (I) |
| o, ou, ong | 11 (O) |
| u, un | 12 (U) |
| ü, üe | 12 (U) |

### TalkingHead streamAudio 接口

TalkingHead 原生支持外部传入 viseme 数据，传入后跳过内部 MFCC 分析：

```typescript
head.streamAudio({
  audio: int16Buffer,       // PCM 音频数据
  visemes: [6, 10],         // viseme ID 序列
  vtimes: [0, 60],          // 每个 viseme 起始时间 ms
  vdurations: [60, 60]      // 每个 viseme 持续时间 ms
});
```

---

## 三、方案演进路径

### 阶段概览

```
阶段 1（当前）         阶段 2（目标）              阶段 3（终极）
前端频谱分析        →  服务端文本生成 viseme    →  TTS 引擎内部导出
精度低/中文差           序列准确/时间近似           序列+时间都精准
```

---

## 四、服务端 Viseme 生成方案对比

### 方向 1：纯规则（Go pinyin + 时间估算）

**原理**：文本 → go-pinyin 拆声母韵母 → 映射表 → 按比例分配时间

**实现**：
```go
import "github.com/mozillazg/go-pinyin"

func GenerateVisemes(text string, durationMs int) []VisemeFrame {
    // 拆拼音 → 声母韵母 → viseme ID → 按 3:7 比例分配时间
}
```

| 维度 | 评价 |
|------|------|
| 精度 | 序列 90%，时间 60-70% |
| 延迟 | 0 |
| 复杂度 | 低（1-2 天） |
| 语言支持 | 仅中文（英文需另加 CMUDict） |

---

### 方向 2：espeak-ng G2P + 时长估算（推荐起步）

**原理**：用 espeak-ng 的音素合成引擎做 G2P + 时长预测（不用它发声）

**实现**：
```go
func VisemesFromText(text, lang string) ([]VisemeFrame, error) {
    // espeak-ng -v zh -q --pho "你好世界"
    // 输出：音素 + 每个音素估计时长(ms)
    cmd := exec.Command("espeak-ng", "-v", lang, "-q", "--pho", text)
    output, _ := cmd.Output()
    // 解析 → IPA 音素→viseme 映射
}
```

| 维度 | 评价 |
|------|------|
| 精度 | 序列 95%，时间 75-85% |
| 延迟 | <50ms |
| 复杂度 | 低（2-3 天） |
| 语言支持 | 100+ 语言（中英文混合自动处理） |

---

### 方向 3：后处理强制对齐（MFA / CTC）

**原理**：TTS 合成完整句音频后，用对齐工具匹配文本与音频得到精确音素时间

**工具**：
- Montreal Forced Aligner（精度最高，0.5-2s/句）
- torchaudio CTC forced align（GPU 快，0.1-0.3s/句）
- Vosk Go 绑定（词级时间戳，实时）

| 维度 | 评价 |
|------|------|
| 精度 | 序列 95%，时间 90-95% |
| 延迟 | +0.3-2s |
| 复杂度 | 中（需要 Python sidecar） |
| 语言支持 | 中英文都有成熟模型 |

---

### 方向 4：换用原生支持 Viseme 的 TTS

**选项**：
- Azure Speech（商业，中国区可用，直接返回 viseme ID + 时间戳）
- Bert-VITS2（开源，VITS 架构有 duration predictor）
- MeloTTS（开源轻量，CPU 可跑）

| 维度 | 评价 |
|------|------|
| 精度 | 95%+（Azure）/ 90%（Bert-VITS2） |
| 延迟 | 0 |
| 复杂度 | 中（集成新 TTS provider） |
| 语言支持 | Azure 全语种 / Bert-VITS2 中文 |

---

### 方向 5：CosyVoice2 内部导出 Duration

**原理**：修改 CosyVoice2 推理代码，从 attention alignment 提取音素时间

| 维度 | 评价 |
|------|------|
| 精度 | 90-95%（如果可行） |
| 延迟 | 0 |
| 复杂度 | 高（flow-matching 架构难提取） |
| 风险 | 可能不可行 |

---

### 方向 6：前端 MFCC 算法移至服务端（Go port）

**原理**：把 HeadAudio worklet 的 MFCC + Mahalanobis 分类器用 Go 重写，服务端跑

**改进点**：消除双重平滑 + 可看全句做后处理（中值滤波去毛刺）

| 维度 | 评价 |
|------|------|
| 精度 | 序列 70-80%（同模型，英文偏向），时间 90% |
| 延迟 | 需完整音频 |
| 复杂度 | 中（~200 行 DSP 代码移植） |
| 语言支持 | 全语言（但中文精度有限） |

---

## 五、综合对比

| 方向 | 序列精度 | 时间精度 | 延迟 | 多语言 | 实现难度 | 推荐度 |
|------|---------|---------|------|--------|---------|--------|
| 1. Go pinyin | 90% | 60-70% | 0 | 仅中文 | 低 | ★★★ |
| 2. espeak-ng | 95% | 75-85% | <50ms | 全语言 | 低 | ★★★★★ |
| 3. MFA/CTC | 95% | 90-95% | +0.3-2s | 中英 | 中 | ★★★★ |
| 4. 换 TTS | 95%+ | 95%+ | 0 | 看引擎 | 中 | ★★★★ |
| 5. 改 CosyVoice2 | 90-95% | 95% | 0 | 中文 | 高 | ★★ |
| 6. Go port MFCC | 70-80% | 90% | 需音频 | 全语言 | 中 | ★★★ |

---

## 六、同步机制

### 核心原则：用音频播放进度驱动 viseme，不用时钟

```
服务端：文本 → viseme 序列 + 相对时间 → 附加到 sentence_start 下发
前端：  收到 viseme 序列存储
        每播放一帧音频 → framesPlayed++ → 索引对应 viseme → 设置 blendshape
```

### 为什么天然同步

| 场景 | 行为 |
|------|------|
| 音频正常播放 | 每帧推进 viseme，自然同步 |
| 网络卡顿 | 无新帧 → viseme 不动（嘴停住） |
| 网络恢复突发 | 快速推进 viseme（追赶） |
| 用户打断 | 停止计数，viseme 重置 |

### 时间缩放（可选）

服务端估算时长 vs 实际音频时长可能有偏差，前端可按比例缩放：
```typescript
const scale = actualAudioDuration / estimatedVisemeDuration;
// 查找时：currentTimeMs / scale → 对应 viseme
```

实际上 ±30% 偏差内不缩放也可接受 — 人眼对嘴型序列是否正确远比时间偏差敏感。

---

## 七、协议设计

### 现有协议（不变）

```json
{"type": "tts", "state": "start", "session_id": "xxx"}
{"type": "tts", "state": "sentence_start", "text": "你好世界", "session_id": "xxx"}
[binary audio frames × N]
{"type": "tts", "state": "sentence_end", "text": "你好世界", "session_id": "xxx"}
{"type": "tts", "state": "stop", "session_id": "xxx"}
```

### 扩展：sentence_start 附加 visemes 字段

```json
{
  "type": "tts",
  "state": "sentence_start",
  "text": "你好世界",
  "session_id": "xxx",
  "visemes": [
    {"id": 6, "t": 0, "d": 70, "w": 0.65},
    {"id": 10, "t": 70, "d": 120, "w": 0.7},
    {"id": 5, "t": 190, "d": 60, "w": 0.6},
    {"id": 8, "t": 250, "d": 110, "w": 0.7},
    {"id": 13, "t": 360, "d": 80, "w": 0.65},
    {"id": 12, "t": 440, "d": 100, "w": 0.7}
  ]
}
```

**向后兼容**：`visemes` 为 `omitempty`，旧客户端不受影响。新客户端有 visemes 时用服务端数据，没有时 fallback 到前端分析。

---

## 八、端侧适配

### Web 端（改动极小）

TalkingHead 的 `streamAudio` 原生支持传入 viseme，只需在喂音频时带上对应 viseme：

```typescript
// useVoiceChat.ts — 收到 sentence_start 时存储 visemes
let currentVisemes: VisemeFrame[] = [];
let framesPlayed = 0;

// sentence_start
if (msg.visemes) {
  currentVisemes = msg.visemes;
  framesPlayed = 0;
}

// audio frame
framesPlayed++;
const timeMs = framesPlayed * 60;
const v = currentVisemes.find(f => timeMs >= f.t && timeMs < f.t + f.d);

head.streamAudio({
  audio: int16Buffer,
  visemes: v ? [v.id] : [0],
  vtimes: [0],
  vdurations: [60]
});
```

HeadAudio worklet 保留但不再主导 — 有服务端 viseme 时用服务端的，没有时 fallback。

### Android 端

**WebView 方案**：和 Web 端完全一致，零额外工作。

**原生渲染方案**（SceneView/Filament）：

```kotlin
framesPlayed++
val timeMs = framesPlayed * 60
val viseme = visemes.find { timeMs >= it.t && timeMs < it.t + it.d }
modelInstance.setMorphWeight("viseme_${NAMES[viseme.id]}", viseme.w)
```

### 统一 SDK 封装

```
avatar-lipsync-sdk/
├── web/          → npm 包，TalkingHead + viseme 驱动
├── android/      → AAR 包，WebView 封装 or 原生 Filament
└── protocol/     → 共享的 viseme 协议定义
```

Web 和 Android 用同一个 WebView 渲染时，代码完全复用。

---

## 九、推荐实施路径

### Phase 1：espeak-ng + 规则（1-2 天）

1. 服务器安装 espeak-ng
2. Go 服务新建 `viseme.go`，调 espeak-ng 生成 viseme 序列
3. `ServerMessage` 添加 `Visemes` 字段
4. `SendSentenceStart` 附加 visemes
5. 前端 `streamAudio` 透传 viseme ID

验证：发送中英文文字，观察 3D 模型嘴型序列是否正确

### Phase 2：时间校准优化（按需）

- 如果 espeak-ng 时长估算偏差大 → 加前端缩放逻辑
- 如果需要更精准时间 → 引入 Vosk 做词级时间戳 + espeak-ng 做词内音素分配

### Phase 3：终极精度（长期）

- 方案 A：上 Azure Speech（最省事，直接拿 viseme）
- 方案 B：CosyVoice2 替换为 Bert-VITS2（可导出 duration）
- 方案 C：加 MFA sidecar（不换 TTS 引擎，加后处理对齐）

---

## 十、风险与约束

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| espeak-ng 中文 G2P 不准 | 个别字 viseme 错误 | 加自定义修正词典 |
| 时间估算偏差 >30% | 嘴型和声音明显不同步 | 前端缩放 + Vosk 补充 |
| 15 viseme 粒度不够 | 细微口型差异无法表达 | Oculus 标准限制，无法突破 |
| espeak-ng 进程开销 | 高并发时延迟上升 | 连接池 / 长驻进程 / 批处理 |
| Android 低端机 WebGL 性能 | 帧率下降 | 降级为 2D 或简化模型 |
