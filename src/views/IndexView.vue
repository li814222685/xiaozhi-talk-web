<template>
  <AppLoader :assets-ready="assetsReady" />
  <div class="talker">
    <header class="header">
      <div class="header-content">
        <div class="header-left">
          <div class="logo">小智</div>
          <div class="status">
            <span
              :class="['status-dot', isConnected ? 'online' : 'offline']"
            ></span>
            <span class="status-text">{{
              isConnected ? "在线" : isReady ? "重新连接中..." : "连接中..."
            }}</span>
          </div>
        </div>

        <div class="header-right">
          <button
            v-if="!isConnected"
            class="btn-icon"
            @click="reconnect"
            title="重新连接"
          >
            <i class="mdi mdi-refresh icon"></i>
          </button>
          <button
            class="btn-icon"
            :title="isMuted ? '取消静音' : '静音'"
            @click="toggleMute"
          >
            <i
              class="mdi icon"
              :class="isMuted ? 'mdi-volume-off' : 'mdi-volume-high'"
            ></i>
          </button>
          <button class="btn-icon" @click="toggleDebugPanel" title="Lip Sync 评测">
            <i class="mdi mdi-chart-box icon"></i>
          </button>
          <button class="btn-icon" @click="toggleMagic">
            <i class="mdi mdi-auto-fix icon"></i>
          </button>
          <button class="btn-icon" @click="handleToggleDark">
            <i v-if="isDark" class="mdi mdi-white-balance-sunny icon"></i>
            <i v-else class="mdi mdi-weather-night icon"></i>
          </button>
          <button class="btn-icon" @click="toggle">
            <i
              class="mdi icon"
              :class="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
            ></i>
          </button>
          <button class="btn-icon" @click="shareApp">
            <i class="mdi mdi-share icon"></i>
          </button>
        </div>
      </div>
    </header>

    <div class="main-wrapper">
      <aside class="avatar-aside">
        <div class="avatar-container" ref="avatarContainerEl">
          <div v-if="!isTalkingHeadReady" class="avatar-fallback">
            <img
              :src="isPlaying ? speakingAvatar : idleAvatar"
              class="avatar-image"
              alt="Avatar"
            />
          </div>
          <button
            v-if="isTalkingHeadReady"
            class="camera-toggle"
            @click="toggleCamera"
          >
            <i class="mdi mdi-camera"></i>
            {{ cameraView === 'head' ? 'Full' : 'Head' }}
          </button>
        </div>
      </aside>

      <main class="main-content">
        <div class="chat-messages">
          <div v-if="messages.length === 0" class="empty-state">
            <div class="empty-title">开始对话</div>
            <div class="empty-subtitle">输入文字或点击麦克风开始语音对话</div>
          </div>

          <div
            v-for="message in messages"
            :key="message.id"
            :class="['message-wrapper', message.role]"
          >
            <div class="message-bubble">
              <div
                class="message-content markdown-body"
                v-html="renderMarkdown(message.content)"
              ></div>
            </div>
          </div>
        </div>

        <div class="input-area">
          <div class="input-container">
            <button
              class="voice-btn"
              :class="{ recording: isRecording }"
              :disabled="!isConnected || isPlaying"
              @click="handleVoiceClick"
            >
              <i v-if="isRecording" class="mdi mdi-stop voice-icon"></i>
              <i v-else class="mdi mdi-microphone voice-icon"></i>
            </button>

            <textarea
              v-model="inputText"
              class="text-input"
              :placeholder="
                isConnected
                  ? '输入您想问的问题...'
                  : '连接已断开，请刷新页面重新连接'
              "
              rows="1"
              @keydown.enter.exact.prevent="onSendText"
              :disabled="!isConnected || isRecording"
            ></textarea>

            <button
              class="send-btn"
              :disabled="!isConnected || !inputText.trim() || isRecording"
              @click="onSendText"
            >
              <i class="mdi mdi-send send-icon"></i>
            </button>
          </div>
        </div>
      </main>
    </div>

    <ElDialog
      v-model="showSettings"
      title="设置"
      width="420px"
      :close-on-click-modal="true"
      class="settings-dialog"
    >
      <div class="settings-form">
        <div class="settings-field">
          <label>服务器地址</label>
          <ElInput
            v-model="settingsForm.wsUrl"
            placeholder="ws://192.168.112.254:8989/xiaozhi/v1/"
          />
          <span class="settings-hint">留空则使用默认地址（254环境）</span>
        </div>
        <div class="settings-field">
          <label>客户端 ID</label>
          <ElInput
            v-model="settingsForm.clientId"
            type="textarea"
            :rows="2"
            placeholder="Client ID"
            resize="vertical"
          />
        </div>
        <div class="settings-field">
          <label>设备 ID</label>
          <ElInput
            v-model="settingsForm.deviceId"
            type="textarea"
            :rows="2"
            placeholder="Device ID"
            resize="vertical"
          />
        </div>
        <div class="settings-field">
          <label>头像套装</label>
          <ElSelect v-model="settingsForm.avatarIdx" style="width: 100%">
            <ElOption
              v-for="(s, i) in avatarSets"
              :key="i"
              :label="s.name"
              :value="i"
            />
          </ElSelect>
        </div>
      </div>
      <template #footer>
        <ElButton @click="showSettings = false">取消</ElButton>
        <ElButton type="primary" @click="saveSettings">保存</ElButton>
      </template>
    </ElDialog>

    <!-- Lip Sync 评测浮窗 -->
    <LipSyncDebugPanel
      :enabled="showDebugPanel"
      :realtime="lipsyncMetrics.realtime"
      :sentences="lipsyncMetrics.sentences.value"
      :global-stats="lipsyncMetrics.globalStats.value"
      :bench-corpus-names="bench.corpusNames.value"
      :bench-is-running="bench.isRunning.value"
      :bench-progress="bench.progress.value"
      :bench-runs="bench.runs.value"
      @close="toggleDebugPanel"
      @bench-start="(c) => onBenchStart(c)"
      @bench-stop="bench.stopRun()"
      @bench-export="bench.downloadResults()"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from "vue";
import {
  useDark,
  useToggle,
  useFullscreen,
  useClipboard,
  useLocalStorage,
} from "@vueuse/core";
import { marked } from "marked";
import { useVoiceChat } from "@/composables/useVoiceChat";
import { useLipSyncBench } from "@/composables/useLipSyncBench";
import { avatarSets, AVATAR_STORAGE_KEY } from "@/config/avatars";
import AppLoader from "@/components/AppLoader.vue";
import LipSyncDebugPanel from "@/components/LipSyncDebugPanel.vue";
import {
  ElDialog,
  ElInput,
  ElSelect,
  ElOption,
  ElButton,
} from "element-plus";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/button/style/css";

const avatarContainerEl = ref<HTMLElement | null>(null);

// 预处理：服务端 Markdown 可能缺少换行，块级标记挤在一行里无法识别
const preprocessMarkdown = (text: string): string => {
  // ### 标题：确保前面有空行，兼容 ###有空格 和 ###无空格 两种情况
  text = text.replace(/([^\n])(#{1,6}) /g, "$1\n\n$2 ");
  text = text.replace(/([^\n])(#{1,6})([^\s#])/g, "$1\n\n$2 $3");
  // * 无序列表项：确保前面换行（排除 ** 加粗）
  text = text.replace(/([^\n*\s])(\* )/g, "$1\n$2");
  // - 无序列表项
  text = text.replace(/([^\n\-\s])(- )/g, "$1\n$2");
  // 数字编号（1. 2. 等）：前面有任意非换行字符时 → 换行，并补空格让 marked 识别为列表
  // [^\d\s\n] 排除小数（如 3.14）和已有换行的情况
  text = text.replace(/([^\n])\s*(\d+\.)\s*([^\d\s\n])/g, "$1\n\n$2 $3");
  // [出处:...] 引用标记：确保前面换行
  text = text.replace(/([^\n])(\[出处)/g, "$1\n\n$2");
  return text;
};

// Markdown 渲染：预处理 → marked 转 HTML
const renderMarkdown = (content: string): string => {
  if (!content) return "";
  try {
    return marked.parse(preprocessMarkdown(content), { breaks: true, gfm: true, async: false }) as string;
  } catch (e) {
    console.error("[Markdown] 渲染失败:", e);
    return content;
  }
};

// 暗色模式
const isDark = useDark({
  selector: "html",
  attribute: "data-theme",
  valueDark: "dark",
  valueLight: "light",
  storageKey: "xiaozhi-theme",
});
const toggleDark = useToggle(isDark);
const handleToggleDark = () => toggleDark();

// 全屏 & 剪贴板
const { isFullscreen, toggle } = useFullscreen();
const { copy } = useClipboard();

// 语音对话核心逻辑
const {
  isConnected,
  isReady,
  isRecording,
  isPlaying,
  isMuted,
  setMuted,
  isTtsFinished,
  lastAudioAt,
  messages,
  isTalkingHeadReady,
  lipsyncMetrics,
  setCamera,
  init,
  reconnect,
  handleVoiceClick,
  handleSendText,
} = useVoiceChat(() => avatarContainerEl.value);

// Lip Sync 评测面板
const showDebugPanel = ref(false);
const bench = useLipSyncBench({
  sendText: handleSendText,
  isPlaying: () => isPlaying.value,
  isTtsFinished: () => isTtsFinished.value,
  lastAudioAt: () => lastAudioAt.value,
});

// 镜头切换
const cameraView = ref<"head" | "full">("full");
const toggleCamera = () => {
  cameraView.value = cameraView.value === "head" ? "full" : "head";
  setCamera(cameraView.value);
};

const toggleDebugPanel = () => {
  showDebugPanel.value = !showDebugPanel.value;
  if (showDebugPanel.value && !lipsyncMetrics.enabled.value) {
    lipsyncMetrics.toggle();
  }
  if (showDebugPanel.value) {
    lipsyncMetrics.setOnSentenceArchived((m) => bench.collectSentence(m));
  } else {
    lipsyncMetrics.setOnSentenceArchived(null);
  }
};

// 开始批测前清空上一轮句子列表，避免不同语料的结果在面板里混着显示
const onBenchStart = (corpus: string) => {
  lipsyncMetrics.reset();
  bench.startRun(corpus);
};

const toggleMute = () => setMuted(!isMuted.value);


const avatarIndex = useLocalStorage(AVATAR_STORAGE_KEY, 0);
const idleAvatar = computed(
  () => avatarSets[avatarIndex.value]?.idle ?? avatarSets[0].idle
);
const speakingAvatar = computed(
  () => avatarSets[avatarIndex.value]?.speaking ?? avatarSets[0].speaking
);

// 输入框
const inputText = ref("");
const assetsReady = ref(false);

// 发送文字消息
const onSendText = () => {
  handleSendText(inputText.value);
  inputText.value = "";
};

// 设置弹窗
const showSettings = ref(false);
const settingsForm = reactive({ clientId: "", deviceId: "", avatarIdx: 0, wsUrl: "" });

const toggleMagic = () => {
  settingsForm.clientId = localStorage.getItem("xiaozhi_client_id") ?? "";
  settingsForm.deviceId = localStorage.getItem("xiaozhi_device_id") ?? "";
  settingsForm.avatarIdx = avatarIndex.value;
  settingsForm.wsUrl = localStorage.getItem("xiaozhi_ws_url") ?? "";
  showSettings.value = true;
};

const saveSettings = () => {
  if (settingsForm.clientId)
    localStorage.setItem("xiaozhi_client_id", settingsForm.clientId.trim());
  if (settingsForm.deviceId)
    localStorage.setItem("xiaozhi_device_id", settingsForm.deviceId.trim());
  const trimmedUrl = settingsForm.wsUrl.trim();
  if (trimmedUrl) {
    localStorage.setItem("xiaozhi_ws_url", trimmedUrl);
  } else {
    localStorage.removeItem("xiaozhi_ws_url");
  }
  avatarIndex.value = settingsForm.avatarIdx;
  showSettings.value = false;
};

// 分享：复制当前页面链接
const shareApp = () => {
  copy(window.location.href);
};

// 组件挂载：初始化 WebSocket 连接，后台预加载头像图片
onMounted(async () => {
  const permission = await navigator.permissions
    .query({ name: "microphone" as PermissionName })
    .catch(() => null);
  if (permission?.state === "denied") {
    setMuted(true);
  }

  assetsReady.value = true;
  init();

  const preload = [idleAvatar.value, speakingAvatar.value];
  preload.forEach((src) => {
    const img = new Image();
    img.src = src;
  });
});
</script>

<style lang="scss" scoped>
@use "@/views/IndexView.scss";

.camera-toggle {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  cursor: pointer;
  z-index: 10;
  transition: background 0.2s;
  &:hover {
    background: rgba(0, 0, 0, 0.4);
  }
}
</style>
