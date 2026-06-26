// viseme 驱动器 — 优先按服务端下发的精确时序（TimedViseme）调度；
// 退化路径：仅有 visemes 字符串数组时，按进度推算（兼容老服务端）。
//
// 时钟源：deps.getCurrentTime() 应返回 audioContext.currentTime（秒）。
// 句子起播时刻 anchor 在收到第一帧 tick 时记录。

import { ref } from "vue";
import type { TimedViseme } from "@/types/messages";

const VISEME_SIL = "sil";
const FRAME_DURATION_MS = 60;
const FRAMES_PER_VISEME_ZH = 3.5;
const TOTAL_FRAMES_SLACK = 1.15;

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
  mode: "timed" | "legacy";
}

export function useVisemeDriver(deps: VisemeDriverDeps) {
  const isActive = ref(false);

  // legacy 路径状态
  let visemeList: string[] = [];
  let estimatedTotalFrames = 0;
  let totalFrames = 0;

  // timed 路径状态
  let timedList: TimedViseme[] = [];
  let timedTotalMs = 0;

  let sentenceStartTime: number | null = null;
  let mode: "timed" | "legacy" = "legacy";

  const onSentenceStart = (
    visemes: readonly string[] | undefined,
    timedVisemes?: readonly TimedViseme[]
  ) => {
    // 优先用 timedVisemes
    if (timedVisemes && timedVisemes.length > 0) {
      timedList = [...timedVisemes];
      const last = timedList[timedList.length - 1];
      timedTotalMs = last.startMs + last.durMs;
      visemeList = [];
      estimatedTotalFrames = 0;
      totalFrames = 0;
      sentenceStartTime = null;
      mode = "timed";
      isActive.value = true;
      return;
    }
    // 退化：只有 visemes 数组
    if (!visemes || visemes.length === 0) {
      reset();
      return;
    }
    visemeList = [...visemes];
    estimatedTotalFrames = Math.max(
      Math.round(visemes.length * FRAMES_PER_VISEME_ZH),
      1
    );
    totalFrames = estimatedTotalFrames;
    timedList = [];
    timedTotalMs = 0;
    sentenceStartTime = null;
    mode = "legacy";
    isActive.value = true;
  };

  const computeTimed = (): VisemeTickDiag => {
    if (sentenceStartTime === null) {
      sentenceStartTime = deps.getCurrentTime();
    }
    const elapsedMs = (deps.getCurrentTime() - sentenceStartTime) * 1000;
    // 超过整段时长后强制归零，避免嘴停在最后一个开口形
    if (elapsedMs >= timedTotalMs + 50) {
      return {
        viseme: VISEME_SIL,
        intensity: 0,
        progress: 1,
        framesPlayed: Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS)),
        totalFrames: Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS)),
        visemeIdx: timedList.length - 1,
        mode: "timed",
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
        totalFrames: Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS)),
        visemeIdx: 0,
        mode: "timed",
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
    const totalFramesForUI = Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS));
    const framesPlayed = Math.floor((elapsedMs / FRAME_DURATION_MS));

    return {
      viseme: cur.shape,
      intensity,
      progress,
      framesPlayed,
      totalFrames: totalFramesForUI,
      visemeIdx: idx,
      mode: "timed",
    };
  };

  const computeLegacy = (): VisemeTickDiag => {
    if (sentenceStartTime === null) {
      sentenceStartTime = deps.getCurrentTime();
    }
    const elapsedSec = deps.getCurrentTime() - sentenceStartTime;
    const framesPlayed = Math.floor((elapsedSec * 1000) / FRAME_DURATION_MS);

    if (framesPlayed >= totalFrames) {
      totalFrames = Math.max(
        Math.round(framesPlayed * TOTAL_FRAMES_SLACK),
        totalFrames
      );
    }
    const progress = Math.min(framesPlayed / totalFrames, 1);
    const idx = Math.min(
      Math.floor(progress * visemeList.length),
      visemeList.length - 1
    );
    const viseme = visemeList[idx] ?? VISEME_SIL;
    return {
      viseme,
      intensity: 0.7, // legacy 路径下没有 intensity 信息，给中等强度
      progress,
      framesPlayed,
      totalFrames,
      visemeIdx: idx,
      mode: "legacy",
    };
  };

  const compute = (): VisemeTickDiag => {
    if (!isActive.value) {
      return {
        viseme: VISEME_SIL,
        intensity: 0,
        progress: 0,
        framesPlayed: 0,
        totalFrames: 0,
        visemeIdx: 0,
        mode,
      };
    }
    if (mode === "timed" && timedList.length > 0) return computeTimed();
    if (mode === "legacy" && visemeList.length > 0) return computeLegacy();
    return {
      viseme: VISEME_SIL,
      intensity: 0,
      progress: 0,
      framesPlayed: 0,
      totalFrames: 0,
      visemeIdx: 0,
      mode,
    };
  };

  const tick = (): string => compute().viseme;
  const tickWithDiag = (): VisemeTickDiag => compute();

  const onSentenceEnd = () => {
    sentenceStartTime = null;
  };

  const reset = () => {
    visemeList = [];
    timedList = [];
    estimatedTotalFrames = 0;
    totalFrames = 0;
    timedTotalMs = 0;
    sentenceStartTime = null;
    mode = "legacy";
    isActive.value = false;
  };

  const getState = () => ({
    visemes: visemeList,
    timedVisemes: timedList,
    totalFrames: mode === "timed"
      ? Math.max(1, Math.round(timedTotalMs / FRAME_DURATION_MS))
      : estimatedTotalFrames,
    mode,
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
