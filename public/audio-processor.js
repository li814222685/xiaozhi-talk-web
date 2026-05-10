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
        this.port.postMessage(channelData, [channelData.buffer]);
      }
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
