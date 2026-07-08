import { ref } from "vue";
import { TalkingHead } from "@met4citizen/talkinghead";

export function useTalkingHead(containerRef: () => HTMLElement | null) {
  const isReady = ref(false);
  const isAvatarLoaded = ref(false);
  const isSpeaking = ref(false);

  let head: InstanceType<typeof TalkingHead> | null = null;

  // 当前每个 viseme morph 的目标值（由 visemeDriver 写入）
  // 每帧由 update 回调把实际 morph 值朝目标平滑插值，实现帧间过渡
  const visemeTargets = new Map<string, number>();
  const visemeCurrent = new Map<string, number>();
  // [档 1] 帧间插值速度。0.35 → 0.5：每帧朝目标走 50%，嘴更快到位（约 60ms 接近峰值）
  const SMOOTH_FACTOR = 0.5;
  const KNOWN_VISEMES = [
    "aa", "E", "I", "O", "U",
    "PP", "FF", "DD", "kk", "CH", "SS", "nn", "RR", "TH", "sil",
  ];

  const AVATAR_URL = "/avatars/avatar.glb";

  const init = async () => {
    const container = containerRef();
    if (!container) return;

    head = new TalkingHead(container, {
      ttsEndpoint: null,
      ttsApikey: null,
      lipsyncModules: [],
      cameraView: "full",
      cameraDistance: 0,
      modelFPS: 60,
      lightAmbientIntensity: 2.5,
      lightDirectIntensity: 15,
      pcmSampleRate: 16000,
    });

    (head as any).initAudioGraph(16000);
    (head as any).audioStreamGainNode.gain.value = 0;
    (head as any).audioSpeechGainNode.gain.value = 0;

    const audioCtx = head.audioCtx as AudioContext;
    await audioCtx.audioWorklet.addModule("/worklet/playback-worklet.js");
    (head as any).workletLoaded = true;

    try {
      await head.showAvatar({
        url: AVATAR_URL,
        body: "F",
        avatarMood: "neutral",
        lipsyncLang: "en",
      });
      isAvatarLoaded.value = true;
    } catch (e) {
      console.error("[TalkingHead] Avatar load failed:", e);
      return;
    }

    // 接管 head.opt.update 做帧间平滑：每帧把 morph 朝 target 插值
    (head as any).opt.update = (_dt: number) => {
      if (!head) return;
      const mt = (head as any).mtAvatar;
      if (!mt) return;
      for (const name of KNOWN_VISEMES) {
        const target = visemeTargets.get(name) ?? 0;
        const cur = visemeCurrent.get(name) ?? 0;
        if (Math.abs(target - cur) < 0.001 && cur === 0) continue;
        const next = cur + (target - cur) * SMOOTH_FACTOR;
        visemeCurrent.set(name, next);
        const key = "viseme_" + name;
        if (mt[key]) {
          mt[key].newvalue = next;
          mt[key].needsUpdate = true;
        }
      }
    };

    isReady.value = true;
  };

  const streamStart = async () => {
    if (!head || !isReady.value) return;

    const ctx = head.audioCtx as AudioContext;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    resetVisemeState();

    await head.streamStart(
      { sampleRate: 16000, gain: 0 },
      () => { isSpeaking.value = true; },
      () => { isSpeaking.value = false; }
    );
  };

  // 主入口：把 PCM 喂给 worklet 播放；同时按 viseme + intensity 设置 morph 目标。
  // intensity 来自服务端 timedVisemes（精确路径），或调用方给的兜底（legacy）。
  const streamAudioWithViseme = (
    pcmFloat32: Float32Array,
    viseme: string,
    intensity: number
  ) => {
    if (!head) return;

    const int16 = float32ToInt16(pcmFloat32);
    head.streamAudio({ audio: int16.buffer as ArrayBuffer });

    setVisemeTarget(viseme, intensity);
  };

  // setVisemeTarget 更新目标 map：当前 viseme 升起，其它已激活的 viseme **按比例衰减**而非瞬间归零。
  // 这样 viseme 切换时上一个还会"撑一段"，跟新 viseme 形成混合渐变——
  // 模拟真实说话时多个口型共存的效果（HeadAudio 当年就是同时输出 aa+E+I 这种混合）。
  const DECAY_FACTOR = 0.5;
  const setVisemeTarget = (viseme: string, intensity: number) => {
    const clamped = Math.max(0, Math.min(1, intensity));
    if (viseme === "sil" || clamped <= 0.01) {
      // 全部按比例衰减（不是直接归零，让最后一帧能优雅闭合）
      for (const name of KNOWN_VISEMES) {
        if (name === "sil") continue;
        const cur = visemeTargets.get(name) ?? 0;
        visemeTargets.set(name, cur * DECAY_FACTOR);
      }
      return;
    }
    for (const name of KNOWN_VISEMES) {
      if (name === "sil") continue;
      if (name === viseme) {
        visemeTargets.set(name, clamped);
      } else {
        // 其它 viseme 按比例衰减，让它们"撑一段"再消失
        const cur = visemeTargets.get(name) ?? 0;
        visemeTargets.set(name, cur * DECAY_FACTOR);
      }
    }
  };

  const resetVisemeState = () => {
    visemeTargets.clear();
    visemeCurrent.clear();
  };

  const streamEnd = () => {
    if (!head) return;
    head.streamNotifyEnd();
    // 把所有 viseme target 置零，让 opt.update 回调通过插值平滑闭嘴。
    // 不能用 resetVisemeState()（它会 clear 两个 map），否则 update 里
    // target=0 && cur=0 直接 continue，morph 值永远停在最后一帧。
    for (const name of KNOWN_VISEMES) {
      visemeTargets.set(name, 0);
    }
  };

  const streamInterrupt = () => {
    if (!head) return;
    head.streamInterrupt();
    isSpeaking.value = false;
    resetVisemeState();
  };

  const destroy = () => {
    if (head) {
      head.streamStop();
      head.stop();
      head = null;
    }
    resetVisemeState();
    isReady.value = false;
    isAvatarLoaded.value = false;
  };

  const setCamera = (view: "head" | "full") => {
    if (!head) return;
    (head as any).setView(view, 0);
  };

  return {
    isReady,
    isAvatarLoaded,
    isSpeaking,
    init,
    setCamera,
    streamStart,
    streamAudioWithViseme,
    streamEnd,
    streamInterrupt,
    destroy,
  };
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
