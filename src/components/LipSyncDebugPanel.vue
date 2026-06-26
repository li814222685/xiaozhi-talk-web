<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from "vue";
import {
  ElCard,
  ElTag,
  ElProgress,
  ElButton,
  ElSelect,
  ElOption,
  ElTable,
  ElTableColumn,
} from "element-plus";
import "element-plus/es/components/card/style/css";
import "element-plus/es/components/tag/style/css";
import "element-plus/es/components/progress/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/table/style/css";
import "element-plus/es/components/table-column/style/css";
import type { SentenceMetrics } from "@/composables/useLipSyncMetrics";
import type { BenchRun } from "@/composables/useLipSyncBench";

const props = defineProps<{
  enabled: boolean;
  realtime: {
    currentViseme: string;
    drift: number;
    framesPlayed: number;
    totalFrames: number;
    progressPct: number;
  };
  sentences: SentenceMetrics[];
  globalStats: {
    avgDrift: number;
    totalSentences: number;
  };
  // bench
  benchCorpusNames: string[];
  benchIsRunning: boolean;
  benchProgress: { current: number; total: number };
  benchRuns: BenchRun[];
}>();

const emit = defineEmits<{
  close: [];
  benchStart: [corpus: string];
  benchStop: [];
  benchExport: [];
}>();

const expanded = ref(false);
const selectedCorpus = ref("基础对话");

const driftPct = computed(() => Math.abs(props.realtime.drift * 100));
const driftColor = computed(() => {
  if (driftPct.value < 10) return "#67c23a";
  if (driftPct.value < 25) return "#e6a23c";
  return "#f56c6c";
});

const lastRun = computed(() => {
  const runs = props.benchRuns;
  if (runs.length === 0) return null;
  return runs[runs.length - 1];
});
const lastSummary = computed(() => lastRun.value?.summary ?? null);
const driftSign = (d: number) => (d > 0 ? "超前" : d < 0 ? "滞后" : "同步");

const reversedSentences = computed(() => [...props.sentences].reverse());

// 拖拽逻辑
const panelRef = ref<HTMLElement | null>(null);
const dragOffset = ref({ x: 0, y: 0 });
const isDragging = ref(false);
let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;

const onDragStart = (e: MouseEvent) => {
  if (!panelRef.value) return;
  isDragging.value = true;
  startX = e.clientX;
  startY = e.clientY;
  startLeft = dragOffset.value.x;
  startTop = dragOffset.value.y;
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
};

const onDragMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  dragOffset.value.x = startLeft + (e.clientX - startX);
  dragOffset.value.y = startTop + (e.clientY - startY);
};

const onDragEnd = () => {
  isDragging.value = false;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
};

onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
});
</script>

<template>
  <Transition name="fade">
    <div
      v-if="enabled"
      ref="panelRef"
      class="lipsync-float"
      :class="{ expanded }"
      :style="{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }"
    >
      <!-- Collapsed: mini badge -->
      <ElCard
        v-if="!expanded"
        shadow="always"
        class="mini-card"
        @click="expanded = true"
        @mousedown="onDragStart"
      >
        <div class="mini-row">
          <ElTag size="small" :type="driftPct < 10 ? 'success' : driftPct < 25 ? 'warning' : 'danger'">
            {{ realtime.currentViseme }}
          </ElTag>
          <span class="mini-drift" :style="{ color: driftColor }">
            {{ (realtime.drift * 100).toFixed(0) }}%
          </span>
        </div>
      </ElCard>

      <!-- Expanded: full panel -->
      <ElCard v-else shadow="always" class="panel-card">
        <template #header>
          <div class="panel-head" @mousedown="onDragStart">
            <span class="drag-handle">⋮⋮</span>
            <span>LipSync</span>
            <span class="head-actions">
              <ElButton size="small" text @click="expanded = false">_</ElButton>
              <ElButton size="small" text @click="emit('close')">×</ElButton>
            </span>
          </div>
        </template>

        <!-- Realtime -->
        <div class="section">
          <div class="rt-row">
            <ElTag size="small" effect="dark">{{ realtime.currentViseme }}</ElTag>
            <ElProgress
              :percentage="realtime.progressPct"
              :stroke-width="6"
              :show-text="false"
              class="rt-progress"
            />
            <span class="rt-pct">{{ realtime.progressPct }}%</span>
          </div>
          <div class="drift-row">
            <span class="drift-label">Drift</span>
            <ElProgress
              :percentage="Math.min(driftPct * 2, 100)"
              :stroke-width="8"
              :color="driftColor"
              :show-text="false"
              class="drift-bar"
            />
            <span class="drift-val" :style="{ color: driftColor }">
              {{ (realtime.drift * 100).toFixed(1) }}%
            </span>
          </div>
        </div>

        <!-- Stats summary -->
        <div class="section stats-row">
          <div class="stat">
            <div class="stat-num" :style="{ color: driftColor }">{{ (realtime.drift * 100).toFixed(0) }}%</div>
            <div class="stat-lbl">{{ driftSign(realtime.drift) }}</div>
          </div>
          <div class="stat">
            <div class="stat-num">{{ globalStats.totalSentences }}</div>
            <div class="stat-lbl">句</div>
          </div>
        </div>

        <!-- Bench result (批测汇总) -->
        <div class="section bench-score" v-if="lastSummary">
          <div class="bench-result-head">
            <span class="bench-corpus-name">{{ lastRun?.corpus }}</span>
            <ElTag size="small" :type="benchIsRunning ? 'warning' : 'success'">
              {{ benchIsRunning ? '进行中' : '已完成' }}
            </ElTag>
          </div>
          <div class="bench-result-detail">
            <span>句数 {{ lastSummary.totalSentences }}</span>
            <span>平均偏移 {{ (lastSummary.avgDrift * 100).toFixed(0) }}%</span>
            <span>最大偏移 {{ (lastSummary.maxDrift * 100).toFixed(0) }}%</span>
          </div>
        </div>

        <!-- Sentence history (compact) -->
        <div class="section" v-if="reversedSentences.length > 0">
          <ElTable :data="reversedSentences" size="small" max-height="220" class="sentence-table">
            <ElTableColumn type="index" label="#" width="36" />
            <ElTableColumn prop="text" label="文本" min-width="100" show-overflow-tooltip />
            <ElTableColumn label="drift" width="60">
              <template #default="{ row }">
                <span :style="{ color: Math.abs(row.avgDrift) < 0.15 ? '#67c23a' : '#e6a23c' }">
                  {{ (row.avgDrift * 100).toFixed(0) }}%
                </span>
              </template>
            </ElTableColumn>
          </ElTable>
        </div>

        <!-- Bench controls -->
        <div class="section bench-section">
          <ElSelect v-model="selectedCorpus" size="small" class="bench-corpus">
            <ElOption v-for="name in benchCorpusNames" :key="name" :label="name" :value="name" />
          </ElSelect>
          <ElButton
            size="small"
            type="primary"
            :disabled="benchIsRunning"
            @click="emit('benchStart', selectedCorpus)"
          >
            {{ benchIsRunning ? `${benchProgress.current}/${benchProgress.total}` : '批测' }}
          </ElButton>
          <ElButton v-if="benchIsRunning" size="small" type="danger" @click="emit('benchStop')">
            停
          </ElButton>
          <ElButton
            size="small"
            :disabled="benchRuns.length === 0"
            @click="emit('benchExport')"
          >
            导出
          </ElButton>
        </div>
      </ElCard>
    </div>
  </Transition>
</template>

<style scoped>
.lipsync-float {
  position: fixed;
  top: 110px;
  left: 16px;
  z-index: 2000;
  font-size: 12px;
  user-select: none;
}

.mini-card {
  cursor: pointer;
  width: auto;
  --el-card-padding: 8px 12px;
}
.mini-card:hover {
  transform: scale(1.03);
}

.mini-row {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.mini-drift {
  font-weight: 600;
  font-size: 13px;
}

.panel-card {
  width: 320px;
  max-height: 480px;
  overflow-y: auto;
  --el-card-padding: 12px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: 13px;
  cursor: grab;
}
.panel-head:active {
  cursor: grabbing;
}
.drag-handle {
  color: var(--el-text-color-placeholder);
  margin-right: 6px;
  letter-spacing: -2px;
  font-size: 14px;
}
.head-actions {
  display: flex;
  gap: 0;
}

.section {
  margin-bottom: 10px;
}
.section:last-child {
  margin-bottom: 0;
}

.rt-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rt-progress {
  flex: 1;
}
.rt-pct {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  min-width: 28px;
  text-align: right;
}

.drift-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.drift-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  min-width: 30px;
}
.drift-bar {
  flex: 1;
}
.drift-val {
  font-weight: 600;
  font-size: 12px;
  min-width: 40px;
  text-align: right;
}

.stats-row {
  display: flex;
  gap: 12px;
}
.stat {
  text-align: center;
}
.stat-num {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-lbl {
  font-size: 10px;
  color: var(--el-text-color-secondary);
}

.sentence-table {
  font-size: 11px;
}

.bench-score {
  padding: 10px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}
.bench-result-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
}
.bench-corpus-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bench-result-detail {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.bench-section {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.bench-corpus {
  width: 100px;
}

/* transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
