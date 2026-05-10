// 音频录制 — 通过 AudioWorklet 采集麦克风 Float32 PCM 帧（16kHz 单声道）
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";

export function useAudioRecorder() {
  const isRecording = ref(false);

  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;

  // 开始录音，每收到一帧音频数据调用 onFrame 回调
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

    await audioContext.audioWorklet.addModule("/audio-processor.js");

    workletNode = new AudioWorkletNode(audioContext, "audio-processor");
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    // 接收 worklet 发送的 Float32 PCM 帧
    workletNode.port.onmessage = (e) => {
      if (!isRecording.value) return;
      const data = e.data;
      if (data instanceof Float32Array) {
        onFrame(data.buffer.slice(0) as ArrayBuffer);
      } else if (data?.buffer) {
        onFrame(data.buffer.slice(0) as ArrayBuffer);
      }
    };

    isRecording.value = true;
  };

  // 停止录音，释放所有音频资源
  const stop = () => {
    if (!isRecording.value) return;

    if (workletNode) {
      workletNode.port.postMessage({ type: "reset" });
      workletNode.disconnect();
      workletNode = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    isRecording.value = false;
  };

  // 组件卸载时自动停止录音
  tryOnScopeDispose(stop);

  return { isRecording, start, stop };
}
