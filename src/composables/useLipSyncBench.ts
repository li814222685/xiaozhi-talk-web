import { ref, computed } from "vue";
import type { SentenceMetrics } from "./useLipSyncMetrics";

export interface BenchRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  corpus: string;
  sentences: SentenceMetrics[];
  summary: BenchSummary | null;
}

export interface BenchSummary {
  totalSentences: number;
  avgDrift: number;
  maxDrift: number;
}

// 预定义测试语料库（覆盖不同长度、声母韵母、多音字）
const CORPUS: Record<string, string[]> = {
  基础对话: [
    "你好，很高兴认识你",
    "今天天气怎么样",
    "我想吃火锅",
    "请问现在几点了",
    "谢谢你的帮助",
  ],
  声韵覆盖: [
    "八百标兵奔北坡",
    "吃葡萄不吐葡萄皮",
    "四十四只石狮子",
    "黑化肥发灰会挥发",
    "牛郎恋刘娘",
  ],
  多音字: [
    "这个音乐很好听",
    "他还没有还钱",
    "长大了就能当行长了",
    "你什么都没说就走了",
    "我们约好了下午见面",
  ],
  长句: [
    "人工智能技术在最近几年取得了非常显著的进展和突破",
    "我们团队正在开发一款基于大语言模型的智能语音助手产品",
    "这个功能的设计目标是让数字人的嘴型能够跟随语音内容同步变化",
  ],
  中英混合: [
    "请打开WiFi连接",
    "今天的GDP增长了百分之五",
    "iPhone十六什么时候发布",
    "用Python写一个Hello World",
  ],
};

export interface BenchDeps {
  sendText: (text: string) => void;
  isPlaying: () => boolean;
  isTtsFinished: () => boolean;
  lastAudioAt: () => number;
}

export function useLipSyncBench(deps: BenchDeps) {
  const runs = ref<BenchRun[]>([]);
  const isRunning = ref(false);
  const currentRunId = ref(0);
  const currentCorpus = ref("");
  const progress = ref({ current: 0, total: 0 });

  let runCounter = 0;
  let sentenceCollector: SentenceMetrics[] = [];
  let resolveWait: (() => void) | null = null;

  const interruptableDelay = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      resolveWait = resolve;
      setTimeout(() => {
        resolveWait = null;
        resolve();
      }, ms);
    });
  };

  // 整段回复真正播完的判定。不依赖 isPlaying 的 true/false 边沿
  // （边沿会被 jitter buffer 句间排空、或被很短的回复错过），
  // 改用"最后一帧音频时间戳"：
  //   1. 先等服务器开始回复（收到第一帧音频，lastAudioAt 前进）
  //   2. 再等 TTS 已 stop 且距最后一帧音频已超过 QUIET_MS，期间只要又来新帧就继续等
  const QUIET_MS = 1200;
  const waitForPlaybackDone = async (timeoutMs = 30000): Promise<void> => {
    const start = Date.now();
    const baseline = deps.lastAudioAt();

    // 阶段一：等服务器开始回复（出现新音频帧）
    while (deps.lastAudioAt() === baseline && isRunning.value) {
      if (Date.now() - start > timeoutMs) return;
      await interruptableDelay(100);
    }

    // 阶段二：等"已收到 tts stop 且音频静默 QUIET_MS"
    while (isRunning.value) {
      if (Date.now() - start > timeoutMs) return;
      const sinceLastAudio = Date.now() - deps.lastAudioAt();
      if (deps.isTtsFinished() && sinceLastAudio >= QUIET_MS) return;
      await interruptableDelay(120);
    }
  };

  const corpusNames = computed(() => Object.keys(CORPUS));

  const startRun = async (corpusName: string) => {
    const sentences = CORPUS[corpusName];
    if (!sentences || isRunning.value) return;

    isRunning.value = true;
    currentCorpus.value = corpusName;
    sentenceCollector = [];
    const runId = ++runCounter;
    currentRunId.value = runId;
    progress.value = { current: 0, total: sentences.length };

    const run: BenchRun = {
      id: runId,
      startedAt: Date.now(),
      finishedAt: null,
      corpus: corpusName,
      sentences: [],
      summary: null,
    };
    runs.value.push(run);
    // push 后取回响应式代理引用，后续必须改这个而不是原始 run，
    // 否则 summary 等深层赋值绕过代理 setter，面板 computed 不会更新
    const liveRun = runs.value[runs.value.length - 1];

    for (let i = 0; i < sentences.length; i++) {
      if (!isRunning.value) break;
      progress.value.current = i + 1;
      deps.sendText(sentences[i]);
      await waitForPlaybackDone();
      await interruptableDelay(800);
    }

    // 等最后一句播完
    await waitForPlaybackDone();

    liveRun.finishedAt = Date.now();
    liveRun.sentences = [...sentenceCollector];
    liveRun.summary = computeSummary(liveRun.sentences);
    isRunning.value = false;
  };

  const stopRun = () => {
    isRunning.value = false;
    if (resolveWait) resolveWait();
    // 中途停止也结算已收集的句子，让面板能看到评分
    const run = runs.value.find((r) => r.id === currentRunId.value);
    if (run && !run.summary) {
      run.finishedAt = Date.now();
      run.sentences = [...sentenceCollector];
      run.summary = computeSummary(run.sentences);
    }
  };

  // metrics 层每完成一句调用此方法收集
  const collectSentence = (metrics: SentenceMetrics) => {
    if (isRunning.value) {
      sentenceCollector.push(metrics);
    }
  };

  const exportResults = (): string => {
    const data = runs.value.map((r) => ({
      id: r.id,
      corpus: r.corpus,
      startedAt: new Date(r.startedAt).toISOString(),
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      summary: r.summary,
      sentences: r.sentences.map((s) => ({
        text: s.text,
        visemes: s.visemes,
        totalFrames: s.totalFrames,
        avgDrift: s.avgDrift,
        maxDrift: s.maxDrift,
      })),
    }));
    return JSON.stringify(data, null, 2);
  };

  const downloadResults = () => {
    const json = exportResults();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lipsync-bench-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return {
    runs,
    isRunning,
    currentCorpus,
    progress,
    corpusNames,
    startRun,
    stopRun,
    collectSentence,
    exportResults,
    downloadResults,
  };
}

function computeSummary(sentences: SentenceMetrics[]): BenchSummary {
  if (sentences.length === 0) {
    return { totalSentences: 0, avgDrift: 0, maxDrift: 0 };
  }
  const avgDrift = avg(sentences.map((s) => Math.abs(s.avgDrift)));
  const maxDrift = Math.max(...sentences.map((s) => s.maxDrift));

  return { totalSentences: sentences.length, avgDrift, maxDrift };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
