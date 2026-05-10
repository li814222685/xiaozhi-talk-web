import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";

export function useAudioRecorder() {
  const isRecording = ref(false);

  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;

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

    workletNode.port.onmessage = (e) => {
      if (!isRecording.value) return;
      const data = e.data;
      if (data instanceof Float32Array) {
        onFrame(data.buffer);
      } else if (data?.buffer) {
        onFrame(data.buffer);
      }
    };

    isRecording.value = true;
  };

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

  tryOnScopeDispose(stop);

  return { isRecording, start, stop };
}
