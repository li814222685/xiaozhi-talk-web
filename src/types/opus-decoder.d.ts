declare module "opus-decoder" {
  interface OpusDecoderOptions {
    sampleRate?: number;
    channels?: number;
  }

  interface DecodedAudio {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  }

  export class OpusDecoder {
    ready: Promise<void>;
    constructor(options?: OpusDecoderOptions);
    decodeFrame(opusFrame: Uint8Array): DecodedAudio;
    decodeFrames(opusFrames: Uint8Array[]): DecodedAudio;
    free(): void;
    reset(): void;
  }
}
