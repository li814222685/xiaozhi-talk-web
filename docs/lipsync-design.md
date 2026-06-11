# TalkingHead Lip Sync 技术设计文档

## 1. 方案概述

### 架构

```
┌─────────────┐     Opus      ┌──────────────┐    PCM Int16    ┌─────────────────────┐
│  WebSocket  │ ──────────▶   │ OpusDecoder  │ ──────────────▶ │ TalkingHead         │
│  (TTS 音频) │               │ (wasm 解码)   │                 │   streamWorkletNode │
└─────────────┘               └──────────────┘                 └──────────┬──────────┘
                                                                          │
                                          ┌───────────────────────────────┼────────────────┐
                                          │                               │                │
                                          ▼                               ▼                ▼
                                ┌──────────────────┐          ┌────────────────┐   ┌──────────────┐
                                │ audioStreamGain  │          │ audioAnalyzer  │   │  扬声器输出   │
                                │   (gain = 0)     │          │    Node        │   │  (gain = 0)  │
                                │ [静音,不输出]     │          └───────┬────────┘   └──────────────┘
                                └──────────────────┘                  │
                                                                      ▼
                                                            ┌──────────────────┐
                                                            │   HeadAudio      │
                                                            │  (AudioWorklet)  │
                                                            │                  │
                                                            │ MFCC提取 → 高斯  │
                                                            │ 分类器 → Viseme  │
                                                            └───────┬──────────┘
                                                                    │ onvalue(visemeName, weight)
                                                                    ▼
                                                            ┌──────────────────┐
                                                            │  mtAvatar        │
                                                            │  (blendshape)    │
                                                            │                  │
                                                            │ newvalue + ease  │
                                                            │ → mesh 变形      │
                                                            └──────────────────┘
```

### 数据流时序

```
t=0ms    TTS start 信号 → streamStart() → 创建 streamWorkletNode
t=20ms   第1帧 Opus (20ms) → decode → 960 samples Float32 → Int16 → streamAudio()
t=40ms   第2帧 Opus → ...
         ...
         streamWorkletNode 输出 → audioAnalyzerNode → HeadAudio worklet
         HeadAudio 每128 samples 一帧分析 → MFCC → Mahalanobis 距离 → 最近 viseme
         HeadAudio.update(dt) 每动画帧调用 → sigmoid 平滑 → onvalue 回写 blendshape
         TalkingHead.updateMorphTargets(dt) → 指数平滑 → 应用到 mesh
t=end    TTS stop 信号 → streamNotifyEnd()
```

## 2. 核心组件详解

### 2.1 HeadAudio (AudioWorklet)

**职责**：实时音频分析 → viseme 分类

**算法流程（headworklet 内部）**：
1. 输入：128 samples/帧（AudioWorklet 固定 quantum）
2. 预加重滤波（系数 0.97）
3. 汉宁窗 → 512 点 FFT
4. 40 通道梅尔滤波器组
5. 取对数 → DCT → 12 维 MFCC 特征向量
6. 对每个预训练原型计算 Mahalanobis 距离
7. 选取距离最小的 viseme 作为当前活跃 viseme
8. 通过 port.postMessage 通知主线程

**预训练模型**：`model-en-mixed.bin`（14KB）
- 包含 15 个 Oculus viseme 的原型数据
- 每个原型：12 维均值向量 + 12×12 协方差矩阵逆的下三角
- 训练语料：英语混合语音

**参数**：
| 参数 | 值 | 含义 |
|------|-----|------|
| vadGateActiveDb | -35 | VAD 激活阈值（dB）|
| vadGateInactiveDb | -55 | VAD 关闭阈值（dB）|
| FFT 大小 | 512 | 频率分辨率 |
| MFCC 维度 | 12 | 特征向量长度 |
| Mel 滤波器通道 | 40 | 频率分段数 |
| 帧大小 | 128 samples | AudioWorklet quantum |

### 2.2 HeadAudio.update(dt) — 平滑层

```javascript
// 简化逻辑
update(dt) {
  const t = dt / 100;  // dt 单位 ms，30fps 时 dt≈33，t≈0.33
  for (let i = 0; i < 15; i++) {
    if (i === visemeActive) {
      alpha[i] += t;   // 激活的 viseme 递增
      if (alpha[i] > 1) alpha[i] = 1;
    } else {
      alpha[i] -= t;   // 非激活的递减
      if (alpha[i] < 0) alpha[i] = 0;
    }
    const smoothed = visemeMaxs[i] * sigmoid(alpha[i]);
    onvalue(visemeNames[i], smoothed);
  }
}
```

**平滑特性**：
- 上升/下降速率：每 100ms 走完 0→1 或 1→0（约 3 帧 @30fps）
- sigmoid(k=5) 缓动：S 曲线，两端缓入缓出
- visemeMaxs 限制最大权重（大多 0.65，PP/FF 为 0.75）

### 2.3 TalkingHead.updateMorphTargets(dt) — 二次平滑层

接收 `onvalue` 写入的 `newvalue`，再做一层**指数平滑**：

```javascript
// 简化逻辑
acc = 0.01 / 1000;    // 加速度
maxv = 5 / 1000;      // 最大速度
// 每帧：
diff = target - current;
if (abs(diff) < 0.005) → snap
else:
  v += acc * dt;
  v = min(v, maxv);
  current += diff * (1 - exp(-v * dt));
```

**效果**：渐进式加速逼近目标值，有物理惯性感。但因为 acc=0.01 很小，**大幅变化时响应偏慢**。

## 3. 当前代码实现

### 文件结构

```
src/composables/
├── useTalkingHead.ts     ← TalkingHead + HeadAudio 封装
├── useVoiceChat.ts       ← 编排层（WebSocket + 录音 + 播放 + TalkingHead）
├── useAudioPlayer.ts     ← 原有音频播放器（Opus → PCM → 扬声器）
├── useWebSocket.ts       ← WebSocket 连接管理
└── useAudioRecorder.ts   ← 麦克风录音

public/
├── avatars/avatar.glb    ← 3D 模型（Ready Player Me 导出）
├── headaudio/
│   ├── headaudio.min.mjs     ← HeadAudio AudioWorkletNode 类
│   ├── headworklet.min.mjs   ← HeadAudio AudioWorklet 处理器
│   └── model-en-mixed.bin    ← 预训练 viseme 模型
└── worklet/
    └── playback-worklet.js   ← TalkingHead 流式播放 worklet
```

### 关键 Vite 适配

TalkingHead 内部用 `new URL('./playback-worklet.js', import.meta.url)` 加载 worklet，Vite 预构建后路径失效。解决方案：
1. 手动调 `initAudioGraph(16000)` 重建 AudioContext
2. 从 public 目录手动注册 worklet：`audioCtx.audioWorklet.addModule("/worklet/playback-worklet.js")`
3. 设置 `head.workletLoaded = true` 跳过内部加载

## 4. 嘴形过渡不自然的原因分析

### 4.1 双重平滑叠加

信号经过两层平滑：
1. HeadAudio.update：sigmoid 缓动，约 100ms 完成过渡
2. updateMorphTargets：指数平滑 + 加速度模型，acc=0.01 极慢

**叠加效果**：快速语音中的短促音素（如爆破音 P、T、K）被严重平滑掉，嘴型来不及到位就开始回落。

### 4.2 分析帧率限制

- HeadAudio 工作在 128 samples/帧 = 8ms/帧 @16kHz
- 但 viseme 分类是基于 512 点 FFT 窗口（32ms @16kHz）
- 实际 viseme 更新率 ≈ 每 8ms 一次，但特征窗口覆盖 32ms
- **短于 32ms 的音素无法被独立识别**

### 4.3 viseme 粒度

仅 15 个 viseme，对比自然语音中数十种嘴形变化明显不足：
- viseme_aa 覆盖了 /a/、/æ/、/ɑ/ 等多个元音
- 中文声母如 zh/ch/sh/z/c/s 可能全部映射到同一个 viseme（SS 或 CH）

### 4.4 模型训练语料

`model-en-mixed.bin` 针对英语训练，中文音素映射不精确：
- 中文韵母 ü、iu、üe 等无对应 viseme
- 声调变化不影响口型但影响频谱特征，可能干扰分类

## 5. 可调参数与优化空间

### 5.1 HeadAudio 层（可调）

| 参数 | 当前值 | 调整方向 | 影响 |
|------|--------|----------|------|
| visemeMaxs[] | 0.65 | 提高到 0.8-1.0 | 嘴形幅度更大 |
| sigmoid k | 5 | 提高到 8-10 | 过渡更快更锐利 |
| update 速率 t=dt/100 | 100ms 全程 | 改为 dt/50 | 2倍速过渡 |
| vadGateActiveDb | -35 | 降到 -45 | 更灵敏，轻声也能触发 |

**修改方式**：HeadAudio 是 minified 代码，需要 fork 修改或运行时 monkey-patch。

### 5.2 TalkingHead updateMorphTargets 层（可调）

| 参数 | 当前值 | 调整方向 | 影响 |
|------|--------|----------|------|
| mtAccDefault | 0.01 | 提高到 0.05-0.1 | 加速度更大，响应更快 |
| mtMaxVDefault | 5 | 提高到 10-20 | 最大速度更高 |

**修改方式**：在 `setupHeadAudio` 中 patch：
```typescript
// 提高 viseme 相关 morph target 的响应速度
const visemeKeys = ['viseme_aa','viseme_E','viseme_I','viseme_O','viseme_U',
  'viseme_PP','viseme_SS','viseme_TH','viseme_DD','viseme_FF',
  'viseme_kk','viseme_nn','viseme_RR','viseme_CH','viseme_sil'];
for (const key of visemeKeys) {
  if (head.mtAvatar[key]) {
    head.mtAvatar[key].acc = 0.05 / 1000;  // 5x 加速
    head.mtAvatar[key].maxv = 15 / 1000;   // 3x 最大速度
  }
}
```

### 5.3 绕过 updateMorphTargets 平滑（激进方案）

使用 `realtime` 字段而非 `newvalue` 直接设值，跳过指数平滑：

```typescript
headAudio.onvalue = (key, value) => {
  if (head?.mtAvatar?.[key]) {
    head.mtAvatar[key].realtime = value;
    head.mtAvatar[key].needsUpdate = true;
  }
};
```

`realtime` 优先级高于 `newvalue`，且不经过加速度平滑，直接应用。但可能导致抖动。

## 6. 方案上限与下限

### 上限（最好能做到什么程度）

| 维度 | 上限 | 条件 |
|------|------|------|
| 口型准确度 | 英语 70-80% 可辨识 | 使用高质量英语 TTS，语速适中 |
| 中文准确度 | 50-60% 可辨识 | 受限于英语训练模型 |
| 延迟 | 8-30ms（音频到嘴形） | AudioWorklet 帧对齐 |
| 过渡平滑度 | 中等自然 | 调优平滑参数后 |
| 渲染质量 | 半写实 3D（游戏级） | Three.js WebGL 上限 |
| 帧率 | 60fps PC / 30fps 移动端 | 取决于设备 GPU |
| 模型定制 | Ready Player Me 风格 | GLB + ARKit blendshape |

### 下限（最差情况）

| 维度 | 下限 | 原因 |
|------|------|------|
| 快速语音 | 口型跟不上，只有元音变化可见 | 双重平滑 + 32ms 分析窗口 |
| 耳语/轻声 | 完全无反应 | VAD 门限 -35dB |
| 噪声环境 | 误触发随机 viseme | 无噪声消除 |
| 低端移动端 | <15fps，明显卡顿 | WebGL + AudioWorklet 同时跑 |
| 中文特殊音 | 错误口型 | 训练模型不含中文 |
| 无声段（思考中） | 嘴形僵硬 | viseme_sil 是唯一输出 |

### 不可突破的限制

1. **15 viseme 是天花板** — Oculus viseme 标准只有 15 个，无法表达更精细的嘴形差异
2. **前端纯分析不可能做到语音学级别精度** — 没有文本对齐（forced alignment）就不可能知道当前在发什么音素
3. **3D 模型渲染质量不可能达到照片级** — Three.js 不支持次表面散射、微表面毛发等电影级技术
4. **HeadAudio 模型无法在线更新** — 14KB 的预训练二进制模型，无法针对特定说话人自适应

## 7. 与竞品方案对比

| 方案 | 口型精度 | 延迟 | 视觉质量 | 计算位置 | 适用场景 |
|------|----------|------|----------|----------|----------|
| **TalkingHead+HeadAudio（当前）** | ★★★ | <30ms | ★★★ | 纯前端 | Web 实时对话 |
| Rhubarb Lip Sync | ★★★★ | 离线 | - | 前端/后端 | 预录音频 |
| Wav2Lip | ★★★★★ | 200-500ms | ★★★★★ | GPU 服务端 | 真人视频驱动 |
| SadTalker | ★★★★ | 1-3s | ★★★★ | GPU 服务端 | 真人图片驱动 |
| MuseTalk | ★★★★★ | 150-300ms | ★★★★★ | GPU 服务端 | 实时真人 |
| Unreal MetaHuman | ★★★★★ | <10ms | ★★★★★ | 客户端 GPU | AAA 游戏级 |
| Live2D + 口型驱动 | ★★★ | <20ms | ★★★（2D） | 纯前端 | 二次元虚拟人 |
| Azure Viseme (官方) | ★★★★ | 实时 | - | 服务端 | 配合 Azure TTS |

## 8. 改进路线图

### 短期（当前方案内优化）

1. **加速 viseme 响应** — patch mtAvatar 的 acc/maxv 参数
2. **训练中文 viseme 模型** — 用 HeadAudio 的 Training 类录制中文语料生成新的 .bin
3. **增加闲时微动** — 无语音时加入微弱的嘴唇蠕动和呼吸

### 中期（架构升级）

1. **服务端 viseme 推送** — TTS 引擎（CosyVoice2）在合成时同步输出 viseme 时间轴，前端只做播放
2. **切换 Live2D** — 如果二次元风格可接受，Live2D 的 lip sync 生态更成熟
3. **WebGPU 渲染** — 提升移动端帧率和视觉质量

### 长期（方案切换）

1. **MuseTalk/Wav2Lip 服务端渲染** — 真人级别口型精度，需要 GPU 服务器
2. **Unity WebGL 导出** — 用 Unity 的 SALSA LipSync 获得更好的过渡质量
3. **端侧 AI 模型** — WebNN / WASM 跑轻量级 viseme 推理模型
