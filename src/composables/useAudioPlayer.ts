// 音频播放 — 通过 opus-decoder 解码 Opus 帧为 Float32 PCM，送入 AudioWorklet 播放
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { OpusDecoder } from "opus-decoder";

export function useAudioPlayer() {
  const isPlaying = ref(false);

  let audioContext: AudioContext | null = null;
  let playerNode: AudioWorkletNode | null = null;
  let decoder: OpusDecoder | null = null;
  let initialized = false;
  let onEndedCallback: (() => void) | null = null;

  // 初始化解码器和 AudioWorklet（只需调用一次）
  const init = async () => {
    if (initialized) return;

    decoder = new OpusDecoder({ sampleRate: 16000, channels: 1 });
    await decoder.ready;

    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule("/worklet/player-processor.js");
    playerNode = new AudioWorkletNode(audioContext, "player-processor");
    playerNode.connect(audioContext.destination);

    // 监听 worklet 队列播放完毕的通知
    playerNode.port.onmessage = (e) => {
      if (e.data?.type === "ended") {
        isPlaying.value = false;
        onEndedCallback?.();
      }
    };

    initialized = true;
  };

  // 注册播放结束回调
  const onEnded = (cb: () => void) => {
    onEndedCallback = cb;
  };

  // 恢复 suspended 状态（浏览器要求用户交互后才能播放）
  const resume = async () => {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }
  };

  // 解码一帧 Opus 数据并送入播放队列
  const play = (buffer: ArrayBuffer) => {
    if (!playerNode || !audioContext || !decoder) return;

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    const opusFrame = new Uint8Array(buffer);
    const { channelData, samplesDecoded } = decoder.decodeFrame(opusFrame);

    if (samplesDecoded > 0 && channelData[0]) {
      playerNode.port.postMessage({ audioBuffer: channelData[0] }, [
        channelData[0].buffer,
      ]);
    }

    isPlaying.value = true;
  };

  // 停止播放，清空队列
  const stop = () => {
    if (playerNode) {
      playerNode.port.postMessage({ command: "clear" });
    }
    isPlaying.value = false;
  };

  // 销毁所有资源
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
    if (decoder) {
      decoder.free();
      decoder = null;
    }
    initialized = false;
  };

  tryOnScopeDispose(destroy);

  return { isPlaying, init, resume, play, stop, onEnded };
}
