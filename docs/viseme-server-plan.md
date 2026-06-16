# 服务端 Viseme 生成方案对比

## 背景

### 现状

- **TTS 引擎**：CosyVoice2，部署在 Triton（192.168.112.254:8000-8002），输出 16kHz Opus 流
- **服务端**：Go 服务（hologuide_server），通过 WebSocket 向前端下发 TTS 控制消息 + 音频帧
- **前端 lip sync**：TalkingHead + HeadAudio，基于音频频谱（MFCC）实时分析生成 viseme
- **3D 模型**：Ready Player Me GLB，包含 15 个 Oculus viseme morph target

### 问题

前端频谱分析方案的本质缺陷：
1. 只能看到频谱形状，不知道在发什么音 → 相似频谱的不同音素会映射到同一个 viseme
2. 训练模型是英语语料（model-en-mixed.bin），中文音素映射不精准
3. 双重平滑（HeadAudio sigmoid + TalkingHead 指数平滑）导致快速语音口型跟不上

### 目标

将 viseme 推理从前端移到服务端，随 TTS 消息一起下发 viseme 时间轴。前端只负责按时间戳驱动 blendshape 渲染。

### 现有协议

```json
{"type": "tts", "state": "sentence_start", "text": "你好世界", "session_id": "xxx"}
// ... 若干 binary audio frames ...
{"type": "tts", "state": "sentence_end", "text": "你好世界", "session_id": "xxx"}
```

### 目标协议

```json
{
  "type": "tts",
  "state": "sentence_start",
  "text": "你好世界",
  "session_id": "xxx",
  "visemes": [
    {"id": 6, "t": 0, "d": 60, "w": 0.65},
    {"id": 10, "t": 60, "d": 100, "w": 0.7},
    {"id": 5, "t": 160, "d": 70, "w": 0.6},
    {"id": 8, "t": 230, "d": 110, "w": 0.7}
  ]
}
```

---

## 方向 1：纯规则方案（Go pinyin + 时间估算）

### 原理

文本 → go-pinyin 拆为声母/韵母 → 固定映射表转 viseme ID → 按声韵比例分配时间

### 实现路径

1. 引入 `github.com/mozillazg/go-pinyin`
2. 新建 `internal/domain/tts/viseme.go`，实现 `GenerateVisemes(text string, durationMs int) []VisemeFrame`
3. `ServerMessage` 添加 `Visemes` 字段
4. `SendSentenceStart` 时调用生成，附加到消息

### 时间估算方式

- 方案 A：固定每字 250ms（简单粗暴）
- 方案 B：根据 TTS frameDuration × 预估帧数（需要缓存或预计算）
- 方案 C：前端收到音频后，按实际播放时长线性缩放 viseme 时间轴

### 优势

- 零额外延迟（text 可用时即可计算）
- 纯 Go 实现，无外部服务依赖
- 实现简单，1-2 天完成
- 口型序列（哪些音素对应哪些嘴型）是准确的

### 劣势

- 时间分配是估算的，快语速/慢语速时口型和音频会漂移
- 不考虑连读、轻声、儿化等语音现象
- 标点和停顿的时间处理粗糙

### 精度评估

- 口型序列正确率：~90%（拼音→viseme 映射是确定性的）
- 时间对齐精度：~60-70%（均分策略 vs 实际语音时长）
- 综合视觉效果：比前端频谱分析好（序列对了），但嘴型和声音"对不齐"

---

## 方向 2：CosyVoice2 内部导出 Duration

### 原理

CosyVoice2 的 `ttsfrd` 前端已做 G2P（文本→音素），合成过程中隐式包含音素-时间对齐信息。修改推理代码导出 duration 数据。

### 实现路径

1. 修改 CosyVoice2 推理脚本，在 `ttsfrd` 输出拼音阶段建立音素→viseme 映射
2. 从 flow-matching decoder 的 attention/alignment 中提取每个音素的时间占比
3. Triton 输出新增 viseme 字段，Go 服务透传

### 技术难点

CosyVoice2 是 flow-matching + codec 架构：
- 不像 FastSpeech2 有显式 duration predictor
- Attention alignment 是连续的，不是离散的音素边界
- 需要对模型架构有深入理解，可能需要额外训练一个 duration predictor

### 优势

- 零额外延迟（合成时同步产出）
- 时间对齐最精准（直接来自模型内部信息）
- 不增加额外服务

### 劣势

- 实现难度高，需要深入 CosyVoice2 源码
- Flow-matching 架构可能根本无法可靠提取音素级 duration
- 改动影响 Triton pipeline 稳定性
- 维护成本高（模型升级时需要同步适配）

### 精度评估

- 如果能成功提取：90-95%
- 风险：可能投入大量时间后发现不可行

---

## 方向 3：后处理强制对齐（MFA / CTC）

### 原理

TTS 合成完整句音频后，用强制对齐工具将已知文本与音频匹配，得到每个音素的精确起止时间。

### 工具选择

| 工具 | 语言 | 中文支持 | 速度 | 精度 |
|------|------|----------|------|------|
| Montreal Forced Aligner (MFA) | Python | 有官方中文模型 | 0.5-2s/句 | 95% |
| torchaudio CTC forced align | Python | Wav2Vec2 多语言 | 0.1-0.3s/句(GPU) | 90% |
| Allosaurus | Python | 多语言音素识别 | 0.2-0.5s/句 | 85% |
| Kaldi (Vosk) | C++/Python | 中文模型 | 0.1-0.3s/句 | 90% |

### 实现路径

1. 部署 Python sidecar 服务（gRPC 或 HTTP）
2. Go 服务 TTS 合成完一句后，将 wav + text 发给 sidecar
3. Sidecar 返回音素时间对齐 → 映射为 viseme 时间轴
4. Go 服务将 viseme 附加到 `sentence_start`（或在音频帧全部发完后单独补发）

### 架构

```
Go 服务 → CosyVoice2 (Triton) → 音频
   │                                │
   └──── text + wav ────→ Alignment Sidecar (Python)
                                    │
                          viseme timeline ←──┘
```

### 时序问题

MFA 需要完整音频才能跑，所以有两种集成方式：
- **方式 A**：等整句合成完 → 对齐 → 再开始下发（增加 0.5-2s 延迟）
- **方式 B**：先下发音频，异步对齐完成后补发 viseme 消息（前端延迟开始口型）
- **方式 C**：先用方向 1 规则预估下发，对齐完成后发修正时间轴

### 优势

- 不需要修改 TTS 引擎
- 精度高，中文音素时间对齐成熟
- 可以独立演进，不影响 TTS pipeline

### 劣势

- 增加延迟（方式 A：0.5-2s；方式 B/C：复杂度高）
- 需要部署额外 Python 服务
- CPU/GPU 资源消耗（对齐模型）
- Go 跨语言调用增加故障点

### 精度评估

- 口型序列正确率：95%+
- 时间对齐精度：90-95%（MFA 级别）
- 综合视觉效果：接近专业级

---

## 方向 4：换用原生支持 Viseme 的 TTS 引擎

### 选项 A：Azure Speech（商业）

- 直接返回 viseme ID + 时间戳 + 可选 55 维 blend shape
- 中文 zh-CN 完整支持（XiaoxiaoNeural 等多个声音）
- 中国区（chinaeast2）可用
- 价格：~¥10/百万字符

```xml
<speak version="1.0" xmlns:mstts="http://www.w3.org/2001/mstts">
  <voice name="zh-CN-XiaoxiaoNeural">
    <mstts:viseme type="redlips_front"/>
    你好世界
  </voice>
</speak>
```

### 选项 B：Bert-VITS2（开源自部署）

- VITS 架构，有显式 duration predictor
- 中文质量高（fishaudio/Bert-VITS2）
- 改推理代码即可导出 phoneme duration → viseme

### 选项 C：MeloTTS（开源轻量）

- MyShell 开源，VITS 架构，多语言
- CPU 可跑，延迟低
- 同样有 duration predictor 可提取

### 实现路径（以 Azure 为例）

1. 在 xiaozhi 后台配置 Azure Speech 作为 TTS provider
2. Go 服务 TTS provider 接口已支持多引擎（现有 Doubao/Edge/CosyVoice 等）
3. Azure SDK 的 viseme callback 收集 viseme 事件
4. 随 sentence_start 一起下发

### 优势

- 开箱即用，精度最高（Azure 95%+）
- 架构最干净，viseme 和音频天然同步
- Azure：无需维护模型，SLA 保证
- Bert-VITS2/MeloTTS：可自定义音色，本地部署

### 劣势

- Azure：有费用，依赖外部服务，音色可能与 CosyVoice2 不同
- Bert-VITS2：需要额外 GPU 部署，音质可能不如 CosyVoice2
- 换引擎意味着音色变化，用户体验不连续
- 如果保留 CosyVoice2 作为主 TTS，这个方案就变成"双引擎"

### 精度评估

- Azure：95%+（官方优化过的中文 viseme）
- Bert-VITS2：90%+（duration predictor 精度）
- MeloTTS：85-90%

---

## 方向 5：混合渐进方案（规则先行 + 后续修正）

### 原理

分两阶段下发：
1. `sentence_start` 时用规则方案（方向 1）即时下发预估 viseme 时间轴
2. 音频全部合成完后，异步跑对齐（方向 3），发送修正时间轴

### 协议扩展

```json
// 第一次：预估时间轴（sentence_start 时）
{"type": "tts", "state": "sentence_start", "text": "你好", "visemes": [...]}

// 第二次：修正时间轴（sentence_end 后，可选）
{"type": "viseme_update", "visemes": [...], "session_id": "xxx"}
```

### 前端处理

- 收到初始 visemes：开始按时间轴驱动
- 收到 viseme_update：平滑切换到修正时间轴（如果偏差较大）
- 如果从未收到 update：继续使用初始预估（降级为方向 1）

### 优势

- 首帧零延迟（用户体验好）
- 后续精度可以逐步提升
- 对齐服务挂了不影响基本功能（优雅降级）
- 可以渐进式开发：先上方向 1，再加对齐

### 劣势

- 实现复杂度最高（两套逻辑 + 前端热更新）
- 修正时可能产生嘴型跳变
- 调试困难（两个时间轴交接点容易出 bug）

### 精度评估

- 初始阶段：60-70%（方向 1 水平）
- 修正后：85-95%（取决于对齐方案）
- 平均体验：80-85%（大部分时间在用修正后的时间轴）

---

## 综合对比

| 维度 | 方向1 规则 | 方向2 TTS内部 | 方向3 后处理对齐 | 方向4 换引擎 | 方向5 混合 |
|------|-----------|--------------|----------------|-------------|-----------|
| 精度 | ★★★ | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★★ |
| 延迟 | 0 | 0 | +0.3-2s | 0 | 0 |
| 实现难度 | 低 | 高 | 中 | 中 | 高 |
| 维护成本 | 低 | 高 | 中 | 低(Azure)/中 | 中 |
| 外部依赖 | go-pinyin | 改模型 | Python sidecar | Azure/新TTS | 规则+sidecar |
| 开发周期 | 1-2天 | 1-2周+ | 3-5天 | 2-3天 | 1-2周 |
| 风险 | 低 | 高(可能不可行) | 低 | 低 | 中 |

## 推荐策略

**短期（1-2天）**：方向 1 纯规则方案跑通全链路。验证协议、前端驱动、渲染效果。

**中期（根据效果决定）**：
- 如果规则方案视觉效果可接受 → 继续优化映射表和时间比例
- 如果时间漂移明显 → 升级到方向 3（加 CTC 对齐 sidecar）
- 如果决定 TTS 音色不重要 → 方向 4 Azure 最省心

**长期**：方向 2（从 TTS 内部导出）是终极方案，但前提是找到可行的提取路径。
