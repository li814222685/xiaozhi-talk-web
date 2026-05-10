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
            v-for="(message, index) in messages"
            :key="message.id"
            :class="['message-wrapper', message.role]"
          >
            <div class="message-bubble">
              <p class="message-content">
                {{ message.content
                }}<span
                  v-if="
                    message.role === 'assistant' &&
                    index === messages.length - 1 &&
                    isTyping
                  "
                  class="typing-cursor"
                  >|</span
                >
              </p>
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
              :disabled="!isConnected || isRecording || isPlaying"
            ></textarea>

            <button
              class="send-btn"
              :disabled="
                !isConnected || !inputText.trim() || isRecording || isPlaying
              "
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
import { useVoiceChat } from "@/composables/useVoiceChat";
import { avatarSets, AVATAR_STORAGE_KEY } from "@/config/avatars";
import AppLoader from "@/components/AppLoader.vue";
import { ElDialog, ElInput, ElSelect, ElOption, ElButton } from "element-plus";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/button/style/css";

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
  isTyping,
  messages,
  init,
  reconnect,
  handleVoiceClick,
  handleSendText,
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
const settingsForm = reactive({ clientId: "", deviceId: "", avatarIdx: 0 });

const toggleMagic = () => {
  settingsForm.clientId = localStorage.getItem("xiaozhi_client_id") ?? "";
  settingsForm.deviceId = localStorage.getItem("xiaozhi_device_id") ?? "";
  settingsForm.avatarIdx = avatarIndex.value;
  showSettings.value = true;
};

const saveSettings = () => {
  if (settingsForm.clientId)
    localStorage.setItem("xiaozhi_client_id", settingsForm.clientId.trim());
  if (settingsForm.deviceId)
    localStorage.setItem("xiaozhi_device_id", settingsForm.deviceId.trim());
  avatarIndex.value = settingsForm.avatarIdx;
  showSettings.value = false;
};

// 分享：复制当前页面链接
const shareApp = () => {
  copy(window.location.href);
};

// 组件挂载：预加载头像图片，初始化 WebSocket 连接
onMounted(async () => {
  const permission = await navigator.permissions
    .query({ name: "microphone" as PermissionName })
    .catch(() => null);
  if (permission?.state === "denied") {
    setMuted(true);
  }

  const preload = [idleAvatar.value, speakingAvatar.value];
  await Promise.all(
    preload.map(
      (src) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = src;
        })
    )
  );
  assetsReady.value = true;
  init();
});
</script>

<style lang="scss" scoped>
@use "@/views/IndexView.scss";
</style>
