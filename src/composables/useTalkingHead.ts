import { ref } from "vue";
import { TalkingHead } from "@met4citizen/talkinghead";

export function useTalkingHead(containerRef: () => HTMLElement | null) {
  const isReady = ref(false);
  const isAvatarLoaded = ref(false);
  const isSpeaking = ref(false);

  let head: InstanceType<typeof TalkingHead> | null = null;
  let headAudio: any = null;

  const AVATAR_URL = "/avatars/avatar.glb";

  const init = async () => {
    const container = containerRef();
    if (!container) return;

    head = new TalkingHead(container, {
      ttsEndpoint: null,
      ttsApikey: null,
      lipsyncModules: [],
      cameraView: "head",
      cameraDistance: 0,
      modelFPS: 30,
      lightAmbientIntensity: 2.5,
      lightDirectIntensity: 15,
      pcmSampleRate: 16000,
    });

    // 重建 AudioContext 为 16000Hz，避免 streamStart 时 initAudioGraph 重置 workletLoaded
    (head as any).initAudioGraph(16000);

    try {
      await setupHeadAudio();
    } catch (e) {
      console.error("[TalkingHead] HeadAudio setup failed:", e);
    }

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

    isReady.value = true;
  };

  const setupHeadAudio = async () => {
    if (!head) return;

    const audioCtx = head.audioCtx as AudioContext;

    // 提前注册 playback-worklet（TalkingHead 内部用 import.meta.url 解析路径在 Vite 下会失败）
    await audioCtx.audioWorklet.addModule("/worklet/playback-worklet.js");
    (head as any).workletLoaded = true;
    console.log("[TalkingHead] playback-worklet registered");

    await audioCtx.audioWorklet.addModule("/headaudio/headworklet.min.mjs");
    console.log("[TalkingHead] headworklet registered");

    const mod = await loadHeadAudioModule();
    const HeadAudioClass = mod.HeadAudio;

    headAudio = new HeadAudioClass(audioCtx, {
      processorOptions: { visemeEventsEnabled: true },
      parameterData: {
        vadGateActiveDb: -35,
        vadGateInactiveDb: -55,
      },
    });
    console.log("[TalkingHead] HeadAudio created");

    await headAudio.loadModel("/headaudio/model-en-mixed.bin");
    console.log("[TalkingHead] model loaded");

    (head as any).audioAnalyzerNode.connect(headAudio);
    console.log("[TalkingHead] HeadAudio connected to audioAnalyzerNode");

    head.audioSpeechGainNode.gain.value = 0;
    head.audioStreamGainNode.gain.value = 0;

    headAudio.onviseme = (ev: any) => {
      console.log("[TalkingHead] viseme event:", ev.viseme);
    };

    headAudio.onvalue = (key: string, value: number) => {
      if (head?.mtAvatar?.[key]) {
        Object.assign(head.mtAvatar[key], {
          newvalue: value,
          needsUpdate: true,
        });
      }
    };

    head.opt.update = headAudio.update.bind(headAudio);
  };

  const streamStart = async () => {
    if (!head || !isReady.value) {
      console.warn("[TalkingHead] streamStart skipped: head=", !!head, "isReady=", isReady.value);
      return;
    }

    const ctx = head.audioCtx as AudioContext;
    if (ctx.state === "suspended") {
      await ctx.resume();
      console.log("[TalkingHead] AudioContext resumed to:", ctx.state);
    }
    console.log("[TalkingHead] streamStart, AudioContext state:", ctx.state);

    await head.streamStart(
      { sampleRate: 16000, gain: 0 },
      () => {
        isSpeaking.value = true;
        console.log("[TalkingHead] onAudioStart");
      },
      () => {
        isSpeaking.value = false;
        console.log("[TalkingHead] onAudioEnd");
      }
    );
  };

  const streamAudio = (pcmFloat32: Float32Array) => {
    if (!head) return;
    const int16 = float32ToInt16(pcmFloat32);
    head.streamAudio({ audio: int16.buffer as ArrayBuffer });
  };

  const streamEnd = () => {
    if (!head) return;
    console.log("[TalkingHead] streamEnd");
    head.streamNotifyEnd();
  };

  const streamInterrupt = () => {
    if (!head) return;
    console.log("[TalkingHead] streamInterrupt");
    head.streamInterrupt();
    isSpeaking.value = false;
  };

  const destroy = () => {
    if (head) {
      head.streamStop();
      head.stop();
      head = null;
    }
    headAudio = null;
    isReady.value = false;
    isAvatarLoaded.value = false;
  };

  return {
    isReady,
    isAvatarLoaded,
    isSpeaking,
    init,
    streamStart,
    streamAudio,
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

async function loadHeadAudioModule(): Promise<any> {
  const url = new URL("/headaudio/headaudio.min.mjs", window.location.origin);
  return import(/* @vite-ignore */ url.href);
}
