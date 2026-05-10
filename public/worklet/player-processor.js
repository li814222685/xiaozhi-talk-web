// 播放 AudioWorklet — 带 jitter buffer，攒够数据再播放，避免网络抖动导致断续
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.started = false;
    this.bufferThreshold = 8; // 攒够 8 帧再开始播放（约 300-400ms 缓冲）
    this.emptyCount = 0; // 队列为空的连续 process 次数
    this.emptyThreshold = 50; // 约 400ms（128 samples / 16kHz = 8ms/次）
    this.port.onmessage = (e) => {
      if (e.data.command === "clear") {
        this.queue = [];
        this.offset = 0;
        this.started = false;
        this.emptyCount = 0;
      } else {
        this.queue.push(e.data.audioBuffer);
        this.emptyCount = 0;
      }
    };
  }

  process(_, outputs) {
    const output = outputs[0][0];
    if (!output) return true;

    // 未开始播放：等待缓冲积累到阈值
    if (!this.started) {
      if (this.queue.length >= this.bufferThreshold) {
        this.started = true;
      } else {
        output.fill(0);
        return true;
      }
    }

    let idx = 0;
    while (idx < output.length) {
      if (this.queue.length === 0) {
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

      if (this.offset >= currentBuffer.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // 队列为空时累计计数，超过阈值才通知主线程
    if (this.queue.length === 0 && this.started) {
      this.emptyCount++;
      if (this.emptyCount >= this.emptyThreshold) {
        this.port.postMessage({ type: "ended" });
        this.started = false;
        this.emptyCount = 0;
      }
    } else {
      this.emptyCount = 0;
    }

    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
