// 录音 AudioWorklet — 攒够 960 samples（60ms@16kHz）后发送一帧到主线程
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(960); // 60ms 帧缓冲
    this.offset = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === "reset") {
        this.offset = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // 每次 128 samples
    let srcOffset = 0;

    // 将输入拼入缓冲，满 960 samples 时发送
    while (srcOffset < channelData.length) {
      const remaining = this.buffer.length - this.offset;
      const copyLen = Math.min(remaining, channelData.length - srcOffset);
      this.buffer.set(channelData.subarray(srcOffset, srcOffset + copyLen), this.offset);
      this.offset += copyLen;
      srcOffset += copyLen;

      if (this.offset >= this.buffer.length) {
        const frame = this.buffer.slice();
        this.port.postMessage(frame, [frame.buffer]);
        this.buffer = new Float32Array(960);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
