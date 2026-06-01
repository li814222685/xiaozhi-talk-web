/**
 * 录音 AudioWorklet Processor
 *
 * 职责：将麦克风采集到的原始 PCM 音频数据按固定帧长（960 samples = 60ms@16kHz）
 *       分帧后发送给主线程，供 Opus 编码器编码。
 *
 * 工作原理：
 *   - Web Audio 的 AudioWorklet 每次 process() 调用只提供 128 samples（约 8ms）
 *   - Opus 编码器需要固定帧长输入（这里选择 60ms = 960 samples@16kHz）
 *   - 因此需要一个内部缓冲区，将多次 128 samples 拼接，攒够 960 samples 后
 *     作为一个完整帧发送给主线程进行编码
 *
 * 数据流：
 *   麦克风 → MediaStreamSource → [本 Worklet: 128 samples 拼帧]
 *   → postMessage(960 samples Float32Array) → 主线程 AudioEncoder → Opus 帧 → WebSocket
 *
 * 帧长计算：
 *   采样率 16000Hz × 0.06s = 960 samples/帧
 *   每次 process() 收到 128 samples，需要 ceil(960/128) = 8 次才能攒满一帧
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 帧缓冲区：960 samples = 60ms@16kHz，对应 Opus 编码器的一帧输入
    this.buffer = new Float32Array(960);
    // 当前缓冲区写入位置
    this.offset = 0;

    // 监听主线程消息（目前仅支持 reset 指令，用于停止录音时清空残留数据）
    this.port.onmessage = (e) => {
      if (e.data?.type === "reset") {
        this.offset = 0;
      }
    };
  }

  /**
   * AudioWorklet 核心回调，由音频渲染线程以 128 samples 为单位持续调用
   * @param {Float32Array[][]} inputs - inputs[0][0] 为单声道 PCM 数据（128 samples）
   * @returns {boolean} 返回 true 保持 processor 存活
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // 每次 process 调用收到 128 samples 的单声道 PCM 数据
    const channelData = input[0];
    let srcOffset = 0;

    // 循环将输入数据拷贝到帧缓冲区，满 960 samples 时发送一帧
    while (srcOffset < channelData.length) {
      const remaining = this.buffer.length - this.offset;
      const copyLen = Math.min(remaining, channelData.length - srcOffset);
      this.buffer.set(channelData.subarray(srcOffset, srcOffset + copyLen), this.offset);
      this.offset += copyLen;
      srcOffset += copyLen;

      // 缓冲区满，发送完整帧到主线程
      if (this.offset >= this.buffer.length) {
        const frame = this.buffer.slice();
        // 使用 Transferable 传输，避免拷贝开销
        this.port.postMessage(frame, [frame.buffer]);
        // 重新分配缓冲区（因为旧 buffer 已被 transfer）
        this.buffer = new Float32Array(960);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
