- 既然不能用 Azure，得本地化部署，做英文有几条路。先列方案再讨论。

    当前架构现状

    LLM 文本 → CosyVoice2 → PCM → Opus → 客户端
                  ↓
           lipsync.TextToVisemes (中文 G2P)
                  ↓
           AlignByEnergyPeaks (能量包络，靠汉语一字一峰)
                  ↓
           timedVisemes

    两个对英文失效的环节：G2P 和能量对齐。

    方案

    A：本地 forced aligner（WhisperX / faster-whisper）

    LLM 文本 → CosyVoice2 → PCM
                              ↓
                      WhisperX 输入 audio + text
                              ↓
                      per-word 时间戳 + per-phoneme alignment
                              ↓
                      phoneme → viseme 映射 → timedVisemes

    - G2P：WhisperX 内部用 wav2vec2 phoneme model，英文最准
    - 对齐：WhisperX 本身就是做这个的
    - 本地化：✓ 全套本地 GPU 跑
    - 延迟：300ms~800ms（短句快）
    - 资源：要 1 张 GPU，推荐 4~6GB 显存
    - 难度：中等，Python 服务，Go 通过 gRPC 调

    B：本地 Kaldi MFA (Montreal Forced Aligner)

    - 学术标准，最准
    - 延迟：1~3s（重）
    - 本地化：✓
    - 难度：高，部署复杂
    - 不推荐——延迟太大

    C：本地 phonemizer + 能量对齐（轻量改造）

    英文文本 → phonemizer (espeak-ng 后端) → IPA 音素 → viseme 序列
    PCM → 同样的能量包络对齐

    - G2P：用 espeak-ng 或 Python phonemizer 库，纯规则 + CMU 词典
    - 对齐：用现有能量包络
    - 本地化：✓
    - 延迟：几乎零增量
    - 问题：英文能量包络对齐不准（重读/弱读问题），嘴型会乱跳
    - 难度：低

    D：换 TTS 为内置 viseme 输出的本地模型

    某些开源 TTS 模型在合成时就输出 phoneme 时长：

    ┌─────────────┬────────────────────────────┬────────────────────────┐
    │     TTS     │          内置时长          │          评价          │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ FastSpeech2 │ ✓ duration predictor       │ 老但稳，效果一般       │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ VITS        │ ✓ MAS attention 矩阵       │ 主流，质量好           │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ Coqui XTTS  │ ✗                          │ 商业风险（许可证变动） │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ Piper       │ ⚠️ 基于 VITS，需 hack      │ 轻量，英文质量 OK      │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ Bark        │ ✗                          │ 慢                     │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ F5-TTS      │ ⚠️ flow matching，不直接出 │ 跟 CosyVoice 同类      │
    ├─────────────┼────────────────────────────┼────────────────────────┤
    │ MeloTTS     │ ✓ 基于 VITS，有 attention  │ 多语言、轻量           │
    └─────────────┴────────────────────────────┴────────────────────────┘

    - G2P + 对齐一起解决
    - 本地化：✓
    - 代价：换 TTS = 重新做声音调优、可能音色不如 CosyVoice2

    E：CosyVoice2 内部暴露 LLM tokens（最干净的长期方案）

    CosyVoice2 内部架构：

    Text → Text Encoder → LLM (autoregressive) → Speech Tokens (25Hz)
                                                        ↓
                                              Flow Matching → mel → vocoder → PCM

    LLM 输出的 Speech Tokens 是 25Hz 等间距的，每个 token 对应 40ms 音频。如果让 Triton 把 token 序列 + token-to-phoneme 对齐关系也作为 output tensor 暴露：

    - 拿到了 phoneme-level 精确时长
    - 零延迟增量
    - 但需要改 Triton model.py + 可能要训练时保留对齐信息
    - 难度：高，需要算法同学配合 1~2 周

    推荐路径

    按 ROI 排序：

    阶段 1（本周可做）：方案 C，先跑起来

    英文链路先打通，效果差就差。

    # 后端加 g2p_en 或 phonemizer
    import g2p_en
    g2p = g2p_en.G2p()
    phonemes = g2p("Hello world")  # ['HH', 'AH0', 'L', 'OW1', ' ', 'W', 'ER1', 'L', 'D']
    viseme_seq = [phoneme_to_viseme(p) for p in phonemes]

    - 工作量：~1 天
    - 效果：英文嘴型动起来了，但跟音频对不齐
    - 价值：链路通了，可以拿到真实英文数据后续调试

    阶段 2（下周可做）：方案 A，引入 WhisperX

    方案 C 已跑通的基础上：
    - 部署 WhisperX 为 Python gRPC 服务
    - Go 通过 gRPC 调用，input: audio + text, output: word-level timestamps
    - 用 WhisperX 的 forced alignment 替换能量包络对齐

    - 工作量：3~5 天（部署 + 接入 + 调优）
    - 效果：英文嘴型对齐精度接近 Azure
    - 资源：GPU 1 张，显存 4~6GB

    阶段 3（长期）：方案 E，TTS 内部暴露时长

    最干净，但需要算法配合。可以放在 GPU 不够、或者想彻底解决多语言问题时上。
