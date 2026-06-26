# 数字人口型同步(LipSync)功能实现总结

## 做了什么

给 hologuide 的数字人加了口型同步。简单说就是：后端在 TTS 合成的同时把文本拆成拼音,通过 WebSocket 发给前端,前端根据拼音和播放进度实时控制 3D 模型的嘴型。另外搭了个评测面板方便开发时观察同步效果。

---

## 整体链路

```
用户输入
  ↓
后端 Go 服务 (LLM → TTS → Opus 编码)
  ↓ WebSocket 下发
  │  tts/sentence_start  { text, phonemes: ["ni","hao",...] }
  │  audio 帧流 (60ms/帧, Opus)
  │  tts/sentence_end
  ↓
前端 Vue
  │  Opus 解码得到 PCM
  │  VisemeDriver 根据播放时钟从音素序列里取当前嘴型
  └→ TalkingHead 3D 引擎渲染对应 morph target
```

---

## 后端怎么做的

### 拼音提取

`internal/domain/lipsync/lipsync.go`

用 go-pinyin 库,输入一段中文,输出无声调小写拼音数组。"你好世界"出来就是 `["ni","hao","shi","jie"]`。目前只管中文,英文数字标点直接跳过不出音素——这也是后面"英文段嘴型不准"的根源。

### 什么时候发

`internal/app/server/chat/tts.go`

TTS 的发送循环里,遇到 SentenceStart 类型的队列元素,先看客户端握手时有没有带 `features.lipsync: true`,有的话就调一下 `TextToPhonemes`,把结果塞进 sentence_start 消息里跟文本一起发出去。

### 时序对齐

这里有个细节：sentence_start 不是一拿到就立刻发的,而是走了一个 `delayedSentenceLoop`,延后大约 120ms。原因是服务端会预缓冲 2 帧音频(2 × 60ms = 120ms)再开始发,如果 sentence_start 提前太多到达客户端,前端嘴型就会比声音早启动。加了这个延迟之后,客户端收到 sentence_start 和实际听到第一帧声音基本是同一时刻。

### 音频格式

Opus 编码,24kHz 采样,单声道,每帧 60ms(1440 采样点)。发送节奏通过 playbackTail 控制,始终保持客户端有 120ms 的缓冲余量,不灌太满也不饿着。

---

## 前端怎么做的

前端这块拆了 5 个文件,各管各的事。

### phonemeMap.ts

一张映射表。输入拼音,输出 Oculus 15 viseme 标准里的嘴型 ID。

规则很简单——看韵母决定嘴型：有 a 就张大嘴(aa),有 o 就圆嘴(O),有 e 就半张(E),有 i 就扁嘴(I),有 u 就撅嘴(U)。要是一个音节里没元音(极少见),就按声母的发音部位归类,比如 b/p/m 归到双唇闭合。

这 15 个 viseme ID 对应模型上 15 种嘴的形状(morph target blend shape),渲染引擎根据 ID 去插值。

### useVisemeDriver.ts

核心驱动器,干的事情是"根据播放到哪了,决定现在该用哪个嘴型"。

收到 sentence_start 的时候,把 phonemes 一次性全转成 visemeId 数组,然后估一个总帧数(音素个数 × 3.5,经验值,大约 210ms 一个音节)。

之后每来一帧音频,用 `audioContext.currentTime - 开始时间` 算出播了多少帧,除以总帧数得到进度(0~1),再用进度去 visemeId 数组里取对应位置的值。

有个特殊处理：如果实际播放帧数超过了估算(比如句子里混了数字英文,TTS 合成了音频但 go-pinyin 没给出音素),totalFrames 会动态往上调,防止进度算出来大于 1 导致后面一系列计算崩掉。

### useTalkingHead.ts

对 @met4citizen/talkinghead 这个 3D 库的封装。对外暴露的关键接口就一个：`streamAudioWithViseme(pcmData, visemeId)`——把解码出来的 PCM 音频数据和当前的嘴型 ID 一起丢进去,库内部会设置模型脸部对应的 morph target 权重来驱动嘴巴。

另外还有个 `streamAudio(pcmData)` 接口,这是不传 visemeId 的版本,引擎会用内置的 MFCC 频谱分析来推测嘴型——精度低一些但不需要音素数据,作为 fallback。

### useVoiceChat.ts

编排层,把所有东西串起来。WebSocket 消息进来按 type 分发：

audio 类型 → OpusDecoder 解码 → 如果 VisemeDriver 处于激活状态(有音素),就 tick 一下取 visemeId 连同 PCM 一起喂给 TalkingHead；没有音素就只传 PCM 让 TalkingHead 自己用频谱分析兜底。

tts/sentence_start → 把 phonemes 交给 VisemeDriver 做预处理。

tts/sentence_end → 结算这句话的评测数据。

### useLipSyncMetrics.ts + useLipSyncBench.ts

开发工具,不影响正式功能。每帧记录 drift,按句子汇总。批测模式预设了几组语料(基础对话、绕口令、多音字、长句、中英混合),可以自动连续发送并收集数据,最后导出 JSON。

---

## drift 怎么算的

drift 是目前唯一保留的评测指标,衡量的是嘴型和声音有没有对齐。

计算方法：

```
drift = visemeProgress - audioProgress
```

visemeProgress 是"按播放时钟推算的嘴型进度",audioProgress 是"按实际收到的音频帧推算的音频进度",两个都归一化成 0~1。

直观理解：
- drift 是正数 → 嘴型跑快了,嘴先动了声音还没出来
- drift 是负数 → 嘴型跟慢了,声音先出来嘴还没跟上
- 接近 0 → 同步良好

广播行业有个 ITU-R BT.1359 标准:音频超前 45ms 到滞后 125ms 这个范围内,人眼基本感知不到不同步。我们可以拿这个做参考基线。

---

## 碰到的问题和怎么解的

### drift 爆炸到 -4

表现：含数字或英文的句子(比如"GDP增长了5%"),播放到后半段 drift 突然飙到 -4。

原因：go-pinyin 只给中文字出音素,数字英文不出。总帧数是按音素个数估的,但 TTS 照样给这些内容合成了音频。实际播放时长远超估算,progress 除出来远大于 1,drift 就崩了。

解法：在 VisemeDriver 里加了动态修正——发现实际帧数快超过 totalFrames 的时候,乘以 1.15 往上调。这样嘴型在"无音素"的尾段会停留在最后一个 viseme 附近慢慢收口,而不是数学溢出导致画面僵住。

### 评测指标不靠谱

之前还做了 matchRate(逐帧比较两套 viseme 是否相等)和 coverage(嘴在动的帧占比)和综合评分。用下来发现都不能说明问题：

matchRate 拿内置 MFCC 频谱分析出来的 viseme 当"标准答案",但它有 32ms 延迟而且本身精度就一般,逐帧 exact match 只有 6% 是正常的,不代表嘴型效果差。

coverage 更没什么信息量,嘴乱动也是 100%。

最后把这些全清了,只留 drift。drift 对应视频领域的 AV sync offset 概念,有明确的行业容忍阈值可以对标,不需要额外模型也不需要真人录像做 ground truth。

---

## 当前状态和已知局限

功能层面已经跑通。中文句子的嘴型同步主观体感顺畅。

已知局限：
- 英文/数字/标点不产音素,中英混合句子里英文片段的嘴型是"凑合"的(停在前一个中文的嘴型上)
- 纯英文句子会 fallback 到频谱分析方案,精度低于音素驱动
- drift 目前是无量纲比值,后续可以换算成绝对毫秒并对标 ITU 阈值,更容易解读

后续方向：后端 G2P 升级支持英文音素(CMU 音素集或类似方案),消除中英混合场景的覆盖空洞。
