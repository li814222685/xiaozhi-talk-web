// 录音 AudioWorklet 处理器 — 将麦克风输入的 Float32 PCM 帧直接转发到主线程
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 960; // 60ms at 16kHz
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    if (input && input.length > 0) {
      const channelData = input[0];

      if (channelData && channelData.length > 0) {
        // 转移 buffer 所有权，避免拷贝开销
        this.port.postMessage(channelData, [channelData.buffer]);
      }
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
