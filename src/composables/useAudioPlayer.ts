import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";

export function useAudioPlayer() {
  const isPlaying = ref(false);

  let audioContext: AudioContext | null = null;
  let playerNode: AudioWorkletNode | null = null;
  let initialized = false;

  const init = async () => {
    if (initialized) return;

    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule("/worklet/player-processor.js");
    playerNode = new AudioWorkletNode(audioContext, "player-processor");
    playerNode.connect(audioContext.destination);
    initialized = true;
  };

  const resume = async () => {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }
  };

  const play = (buffer: ArrayBuffer) => {
    if (!playerNode || !audioContext) return;

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    const int16Data = new Int16Array(buffer);
    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32Data[i] = int16Data[i] / 32768;
    }

    playerNode.port.postMessage({ audioBuffer: float32Data }, [
      float32Data.buffer,
    ]);

    isPlaying.value = true;
  };

  const stop = () => {
    if (playerNode) {
      playerNode.port.postMessage({ command: "clear" });
    }
    isPlaying.value = false;
  };

  const destroy = () => {
    stop();
    if (playerNode) {
      playerNode.disconnect();
      playerNode = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    initialized = false;
  };

  tryOnScopeDispose(destroy);

  return { isPlaying, init, resume, play, stop };
}
