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
          <button class="btn-icon" title="调试：发送原始消息" @click="openDebug">
            <i class="mdi mdi-code-json icon"></i>
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
        <div class="avatar-container">
          <img
            :src="isPlaying ? speakingAvatar : idleAvatar"
            class="avatar-image"
            alt="Avatar"
          />
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
              <MarkdownContent
                class="message-content"
                :content="message.content"
              />
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
        <div class="settings-field">
          <label>MCP 模拟服务</label>
          <ElSwitch v-model="settingsForm.mcpEnabled" />
          <span class="settings-hint">开启后前端模拟 MCP 设备端，响应后台工具调用</span>
        </div>
      </div>
      <template #footer>
        <ElButton @click="showSettings = false">取消</ElButton>
        <ElButton type="primary" @click="saveSettings">保存</ElButton>
      </template>
    </ElDialog>

    <ElDialog
      v-model="showDebug"
      title="调试台"
      width="560px"
      :close-on-click-modal="false"
      class="debug-dialog"
    >
      <div class="debug-form">
        <div class="debug-toolbar">
          <ElSelect v-model="debugMode" size="small" style="width: 130px" @change="onDebugModeChange">
            <ElOption label="发送 WS" value="ws" />
            <ElOption label="Mock POI" value="poi" />
          </ElSelect>
          <ElButton size="small" @click="formatDebugJson">格式化</ElButton>
          <span v-if="debugError" class="debug-error">{{ debugError }}</span>
          <span v-else-if="debugMode === 'ws'" class="settings-hint">合法 JSON，直接通过 WS 发出</span>
          <span v-else class="settings-hint">编辑后保存，MCP query_poi 将返回此数据</span>
        </div>
        <div ref="editorEl" class="debug-editor"></div>
      </div>
      <template #footer>
        <ElButton @click="showDebug = false">取消</ElButton>
        <ElButton v-if="debugMode === 'ws'" type="primary" :disabled="!isConnected" @click="sendDebugJson"
          >发送</ElButton
        >
        <ElButton v-else type="success" @click="saveMockPoi"
          >保存</ElButton
        >
      </template>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, reactive, watch } from "vue";
import {
  useDark,
  useToggle,
  useFullscreen,
  useClipboard,
  useLocalStorage,
} from "@vueuse/core";
import { EditorView, basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Compartment } from "@codemirror/state";
import { useVoiceChat } from "@/composables/useVoiceChat";
import { MOCK_POI_KEY, DEFAULT_MOCK_POI } from "@/composables/useWebSocket";
import MarkdownContent from "@/components/MarkdownContent.vue";
import { avatarSets, AVATAR_STORAGE_KEY } from "@/config/avatars";
import AppLoader from "@/components/AppLoader.vue";
import { ElDialog, ElInput, ElSelect, ElOption, ElButton, ElSwitch } from "element-plus";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/switch/style/css";

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
  messages,
  init,
  reconnect,
  handleVoiceClick,
  handleSendText,
  sendRaw,
} = useVoiceChat();

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
const settingsForm = reactive({ clientId: "", deviceId: "", avatarIdx: 0, wsUrl: "", mcpEnabled: false });

const toggleMagic = () => {
  settingsForm.clientId = localStorage.getItem("xiaozhi_client_id") ?? "";
  settingsForm.deviceId = localStorage.getItem("xiaozhi_device_id") ?? "";
  settingsForm.avatarIdx = avatarIndex.value;
  settingsForm.wsUrl = localStorage.getItem("xiaozhi_ws_url") ?? "";
  settingsForm.mcpEnabled = localStorage.getItem("xiaozhi_mcp_enabled") === "true";
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
  localStorage.setItem("xiaozhi_mcp_enabled", String(settingsForm.mcpEnabled));
  avatarIndex.value = settingsForm.avatarIdx;
  showSettings.value = false;
  window.location.reload();
};

// 调试弹窗：直接向 WS 发送原始 JSON
const DEBUG_JSON_KEY = "xiaozhi_debug_json";
const DEFAULT_DEBUG_JSON = JSON.stringify(
  {
    type: "iot",
    session_id: "",
    payload: {
      type: "face_detected",
      person_name: "",
      title: "未知",
      status: "success",
    },
  },
  null,
  2
);
const showDebug = ref(false);
const debugError = ref("");
const debugMode = ref<"ws" | "poi">("ws");
const editorEl = ref<HTMLElement | null>(null);

// CodeMirror 实例（非响应式，Vue 不需要追踪其内部状态）
let editorView: EditorView | null = null;
// Compartment：让主题（明/暗）可在运行时热切换，无需重建整个编辑器
const themeCompartment = new Compartment();

const getEditorText = () => editorView?.state.doc.toString() ?? "";
const setEditorText = (text: string) => {
  editorView?.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: text },
  });
};

// 格式化 + 顺带校验 JSON 合法性
const formatDebugJson = () => {
  try {
    setEditorText(JSON.stringify(JSON.parse(getEditorText()), null, 2));
    debugError.value = "";
  } catch (e) {
    debugError.value = "JSON 格式错误：" + (e as Error).message;
  }
};

const createEditor = () => {
  if (!editorEl.value) return;
  editorView = new EditorView({
    doc: localStorage.getItem(DEBUG_JSON_KEY) || DEFAULT_DEBUG_JSON,
    parent: editorEl.value,
    extensions: [
      basicSetup,
      json(),
      themeCompartment.of(isDark.value ? oneDark : []),
      EditorView.theme({ "&": { height: "300px", fontSize: "13px" } }),
      // 粘贴后下一帧自动格式化（先让默认粘贴生效，再重排）
      EditorView.domEventHandlers({
        paste: () => {
          setTimeout(formatDebugJson, 0);
        },
      }),
    ],
  });
};

// 明暗主题切换时，热替换编辑器主题
watch(isDark, (dark) => {
  editorView?.dispatch({
    effects: themeCompartment.reconfigure(dark ? oneDark : []),
  });
});

const openDebug = () => {
  debugError.value = "";
  debugMode.value = "ws";
  showDebug.value = true;
  nextTick(() => {
    if (!editorView) {
      createEditor();
    } else {
      setEditorText(localStorage.getItem(DEBUG_JSON_KEY) || DEFAULT_DEBUG_JSON);
    }
  });
};

const getPoiText = () => {
  const stored = localStorage.getItem(MOCK_POI_KEY);
  if (stored) {
    try {
      return JSON.stringify(JSON.parse(stored), null, 2);
    } catch {
      localStorage.removeItem(MOCK_POI_KEY);
    }
  }
  return JSON.stringify(DEFAULT_MOCK_POI, null, 2);
};

const onDebugModeChange = (mode: "ws" | "poi") => {
  debugError.value = "";
  if (mode === "poi") {
    setEditorText(getPoiText());
  } else {
    setEditorText(localStorage.getItem(DEBUG_JSON_KEY) || DEFAULT_DEBUG_JSON);
  }
};

const saveMockPoi = () => {
  const text = getEditorText();
  try {
    JSON.parse(text);
  } catch (e) {
    debugError.value = "JSON 格式错误：" + (e as Error).message;
    return;
  }
  localStorage.setItem(MOCK_POI_KEY, text);
  debugError.value = "";
  showDebug.value = false;
};

const sendDebugJson = () => {
  let payload: unknown;
  const text = getEditorText();
  try {
    payload = JSON.parse(text);
  } catch (e) {
    debugError.value = "JSON 格式错误：" + (e as Error).message;
    return;
  }
  // 压缩成单行发送，同时记住本次内容方便下次调试
  sendRaw(JSON.stringify(payload));
  localStorage.setItem(DEBUG_JSON_KEY, text);
  showDebug.value = false;
};

onBeforeUnmount(() => {
  editorView?.destroy();
  editorView = null;
});

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
</style>
