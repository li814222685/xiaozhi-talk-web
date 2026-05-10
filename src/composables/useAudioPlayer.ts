// 音频播放 — 通过 AudioWorklet 播放 Int16 PCM 数据，内部转为 Float32 送入播放器
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";

export function useAudioPlayer() {
  const isPlaying = ref(false);

  let audioContext: AudioContext | null = null;
  let playerNode: AudioWorkletNode | null = null;
  let initialized = false;

  // 初始化 AudioWorklet 播放器（只需调用一次）
  const init = async () => {
    if (initialized) return;

    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule("/worklet/player-processor.js");
    playerNode = new AudioWorkletNode(audioContext, "player-processor");
    playerNode.connect(audioContext.destination);
    initialized = true;
  };

  // 恢复 suspended 状态的 AudioContext（浏览器要求用户交互后才能播放）
  const resume = async () => {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }
  };

  // 播放一段 Int16 PCM 音频数据，转为 Float32 后 postMessage 给 worklet
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

  // 停止播放，清空 worklet 内部队列
  const stop = () => {
    if (playerNode) {
      playerNode.port.postMessage({ command: "clear" });
    }
    isPlaying.value = false;
  };

  // 销毁播放器，释放所有资源
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

  // 组件卸载时自动销毁
  tryOnScopeDispose(destroy);

  return { isPlaying, init, resume, play, stop };
}
