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

  process(_, outputs) {
    const output = outputs[0][0];
    if (!output) return true;

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

    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
