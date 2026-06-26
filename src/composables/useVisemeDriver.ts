// viseme 驱动器 — 按服务端下发的精确时序（TimedViseme）调度。
//
// 时钟源：deps.getCurrentTime() 应返回 audioContext.currentTime（秒）。
// 句子起播时刻 anchor 在收到第一帧 tick 时记录。

import { ref } from "vue";
import type { TimedViseme } from "@/types/messages";

const VISEME_SIL = "sil";
const FRAME_DURATION_MS = 60;

export interface VisemeDriverDeps {
  getCurrentTime: () => number;
}

export interface VisemeTickDiag {
  viseme: string;
  intensity: number;
  progress: number;
  framesPlayed: number;
  totalFrames: number;
  visemeIdx: number;
}

export function useVisemeDriver(deps: VisemeDriverDeps) {
  const isActive = ref(false);

  let timedList: TimedViseme[] = [];
  let timedTotalMs = 0;
  let sentenceStartTime: number | null = null;

  const onSentenceStart = (timedVisemes?: readonly TimedViseme[]) => {
    if (!timedVisemes || timedVisemes.length === 0) {
      reset();
      return;
    }
    timedList = [...timedVisemes];
    const last = timedList[timedList.length - 1];
    timedTotalMs = last.startMs + last.durMs;
    sentenceStartTime = null;
    isActive.value = true;
  };

  const compute = (): VisemeTickDiag => {
    if (!isActive.value || timedList.length === 0) {
      return {
        viseme: VISEME_SIL,
        intensity: 0,
        progress: 0,
        framesPlayed: 0,
        totalFrames: 0,
        visemeIdx: 0,
      };
    }
    if (sentenceStartTime === null) {
      sentenceStartTime = deps.getCurrentTime();
    }
    const elapsedMs = (deps.getCurrentTime() - sentenceStartTime) * 1000;
    const totalFramesForUI = Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS));
    // 超过整段时长后强制归零，避免嘴停在最后一个开口形
    if (elapsedMs >= timedTotalMs + 50) {
      return {
        viseme: VISEME_SIL,
        intensity: 0,
        progress: 1,
        framesPlayed: totalFramesForUI,
        totalFrames: totalFramesForUI,
        visemeIdx: timedList.length - 1,
      };
    }
    // 二分找当前 viseme：满足 startMs <= elapsedMs < startMs+durMs
    let idx = -1;
    for (let i = timedList.length - 1; i >= 0; i--) {
      if (timedList[i].startMs <= elapsedMs) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      // 还没到第一个 viseme：返回 sil 0 强度，避免冷启动嘴张开
      return {
        viseme: VISEME_SIL,
        intensity: 0,
        progress: 0,
        framesPlayed: 0,
        totalFrames: totalFramesForUI,
        visemeIdx: 0,
      };
    }
    const cur = timedList[idx];
    const localElapsed = elapsedMs - cur.startMs;
    const localProgress = cur.durMs > 0 ? Math.min(localElapsed / cur.durMs, 1) : 1;
    // 强度包络：前 25% 升起、25%~70% 保持、之后衰减到 30%
    let envelope = 1;
    if (localProgress < 0.25) {
      envelope = localProgress / 0.25;
    } else if (localProgress > 0.7) {
      envelope = 1 - ((localProgress - 0.7) / 0.3) * 0.7;
    }
    const intensity = Math.max(0, Math.min(1, cur.intensity * envelope));
    const progress = timedTotalMs > 0 ? Math.min(elapsedMs / timedTotalMs, 1) : 0;
    const framesPlayed = Math.floor(elapsedMs / FRAME_DURATION_MS);

    return {
      viseme: cur.shape,
      intensity,
      progress,
      framesPlayed,
      totalFrames: totalFramesForUI,
      visemeIdx: idx,
    };
  };

  const tick = (): string => compute().viseme;
  const tickWithDiag = (): VisemeTickDiag => compute();

  const onSentenceEnd = () => {
    sentenceStartTime = null;
  };

  const reset = () => {
    timedList = [];
    timedTotalMs = 0;
    sentenceStartTime = null;
    isActive.value = false;
  };

  const getState = () => ({
    timedVisemes: timedList,
    totalFrames: Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS)),
  });

  return {
    isActive,
    onSentenceStart,
    onSentenceEnd,
    tick,
    tickWithDiag,
    getState,
    reset,
  };
}
