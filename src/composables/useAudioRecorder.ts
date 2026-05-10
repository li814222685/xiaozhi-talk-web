// 音频录制 — 麦克风采集 PCM，通过 WebCodecs AudioEncoder 编码为 Opus 后输出
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";

export function useAudioRecorder() {
  const isRecording = ref(false);

  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let encoder: AudioEncoder | null = null;
  let timestamp = 0; // 编码器时间戳（微秒）

  // 开始录音，编码后的 Opus 帧通过 onFrame 回调输出
  const start = async (onFrame: (buffer: ArrayBuffer) => void) => {
    if (isRecording.value) return;

    audioContext = new AudioContext({ sampleRate: 16000 });

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
        channelCount: 1,
      },
    });

    // 创建 Opus 编码器（浏览器原生 WebCodecs）
    encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        onFrame(buf);
      },
      error: () => {},
    });

    encoder.configure({
      codec: "opus",
      sampleRate: 16000,
      numberOfChannels: 1,
      bitrate: 16000,
    });

    timestamp = 0;

    await audioContext.audioWorklet.addModule("/audio-processor.js");

    workletNode = new AudioWorkletNode(audioContext, "audio-processor");
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    // 接收 worklet 发来的 960 samples PCM 帧，送入编码器
    workletNode.port.onmessage = (e) => {
      if (!isRecording.value || !encoder || encoder.state !== "configured")
        return;

      const pcmData = e.data as Float32Array;
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: 16000,
        numberOfFrames: pcmData.length,
        numberOfChannels: 1,
        timestamp,
        data: pcmData.buffer.slice(0) as ArrayBuffer,
      });

      encoder.encode(audioData);
      audioData.close();
      // 递增时间戳（微秒），每帧 60ms = 60000μs
      timestamp += (pcmData.length / 16000) * 1_000_000;
    };

    isRecording.value = true;
  };

  // 停止录音，释放所有资源
  const stop = () => {
    if (!isRecording.value) return;

    if (workletNode) {
      workletNode.port.postMessage({ type: "reset" });
      workletNode.disconnect();
      workletNode = null;
    }

    if (encoder && encoder.state === "configured") {
      encoder.close();
      encoder = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    timestamp = 0;
    isRecording.value = false;
  };

  tryOnScopeDispose(stop);

  return { isRecording, start, stop };
}
