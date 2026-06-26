// Lip Sync 评测指标收集器
// 每帧采集 viseme 数据，按句汇总 drift（嘴型进度 − 音频进度）。

import { ref, reactive, computed } from "vue";

export interface VisemeFrame {
  frameIdx: number;
  timeMs: number;
  viseme: string;
  drift: number;
}

export interface SentenceMetrics {
  id: number;
  text: string;
  visemes: string[];
  startTime: number;
  endTime: number;
  totalFrames: number;
  frames: VisemeFrame[];
  avgDrift: number;
  maxDrift: number;
}

export function useLipSyncMetrics() {
  const enabled = ref(false);
  const currentSentence = reactive({
    text: "",
    visemes: [] as string[],
    frames: [] as VisemeFrame[],
    startTime: 0,
    totalEstimatedFrames: 0,
  });

  const sentences = ref<SentenceMetrics[]>([]);
  const sentenceCounter = ref(0);

  let onSentenceArchived: ((m: SentenceMetrics) => void) | null = null;
  const setOnSentenceArchived = (fn: ((m: SentenceMetrics) => void) | null) => {
    onSentenceArchived = fn;
  };

  const realtime = reactive({
    currentViseme: "sil",
    drift: 0,
    framesPlayed: 0,
    totalFrames: 0,
    progressPct: 0,
  });

  const globalStats = computed(() => {
    if (sentences.value.length === 0) {
      return { avgDrift: 0, totalSentences: 0 };
    }
    const s = sentences.value;
    return {
      avgDrift: avg(s.map((x) => x.avgDrift)),
      totalSentences: s.length,
    };
  });

  const onSentenceStart = (
    text: string,
    visemes: string[],
    estimatedTotalFrames: number
  ) => {
    if (!enabled.value) return;

    if (currentSentence.frames.length > 0) {
      archiveCurrentSentence();
    }

    currentSentence.text = text;
    currentSentence.visemes = [...visemes];
    currentSentence.frames = [];
    currentSentence.startTime = performance.now();
    currentSentence.totalEstimatedFrames = estimatedTotalFrames;

    realtime.framesPlayed = 0;
    realtime.totalFrames = estimatedTotalFrames;
    realtime.progressPct = 0;
  };

  const onFrame = (
    frameIdx: number,
    viseme: string,
    progress: number,
    totalFrames: number
  ) => {
    if (!enabled.value) return;

    const audioProgress =
      totalFrames > 0 ? Math.min(frameIdx / totalFrames, 1) : 0;
    const visemeProgress = progress;
    const drift = visemeProgress - audioProgress;

    const frame: VisemeFrame = {
      frameIdx,
      timeMs: performance.now() - currentSentence.startTime,
      viseme,
      drift,
    };

    currentSentence.frames.push(frame);

    realtime.currentViseme = viseme;
    realtime.drift = drift;
    realtime.framesPlayed = frameIdx;
    realtime.totalFrames = totalFrames;
    realtime.progressPct = Math.round(progress * 100);
  };

  const onSentenceEnd = () => {
    if (!enabled.value) return;
    archiveCurrentSentence();
    realtime.progressPct = 100;
    realtime.framesPlayed = realtime.totalFrames;
  };

  const archiveCurrentSentence = () => {
    const frames = currentSentence.frames;
    if (frames.length === 0) return;

    const drifts = frames.map((f) => f.drift);

    const metrics: SentenceMetrics = {
      id: ++sentenceCounter.value,
      text: currentSentence.text,
      visemes: [...currentSentence.visemes],
      startTime: currentSentence.startTime,
      endTime: performance.now(),
      totalFrames: frames.length,
      frames: [...frames],
      avgDrift: avg(drifts),
      maxDrift: Math.max(...drifts.map(Math.abs)),
    };

    sentences.value.push(metrics);
    currentSentence.frames = [];
    currentSentence.text = "";

    if (onSentenceArchived) onSentenceArchived(metrics);
  };

  const reset = () => {
    sentences.value = [];
    currentSentence.frames = [];
    currentSentence.text = "";
    currentSentence.visemes = [];
    realtime.currentViseme = "sil";
    realtime.drift = 0;
    realtime.framesPlayed = 0;
  };

  const toggle = () => {
    enabled.value = !enabled.value;
    if (!enabled.value) reset();
  };

  return {
    enabled,
    realtime,
    sentences,
    globalStats,
    currentSentence,
    setOnSentenceArchived,
    onSentenceStart,
    onFrame,
    onSentenceEnd,
    reset,
    toggle,
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
