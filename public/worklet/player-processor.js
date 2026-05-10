// 播放 AudioWorklet 处理器 — 维护 Float32 队列，按需填充输出缓冲，支持跨帧连续播放
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      if (e.data.command === "clear") {
        this.queue = [];
        this.offset = 0;
      } else {
        this.queue.push(e.data.audioBuffer);
      }
    };
  }

  // 每次浏览器需要填充 128 帧输出时调用
  process(_, outputs) {
    const output = outputs[0][0];
    if (!output) return true;

    let idx = 0;
    while (idx < output.length) {
      if (this.queue.length === 0) {
        // 队列为空，填充静音
        output.fill(0, idx);
        break;
      }

      const currentBuffer = this.queue[0];
      const remaining = currentBuffer.length - this.offset;
      const copyLength = Math.min(remaining, output.length - idx);

      output.set(
        currentBuffer.subarray(this.offset, this.offset + copyLength),
        idx
      );

      idx += copyLength;
      this.offset += copyLength;

      // 当前缓冲区读完，移出队列
      if (this.offset >= currentBuffer.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
