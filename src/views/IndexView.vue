<template>
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
          <button class="btn-icon" :title="isMuted ? '取消静音' : '静音'" @click="toggleMute">
            <i class="mdi icon" :class="isMuted ? 'mdi-volume-off' : 'mdi-volume-high'"></i>
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
                {{ message.content }}<span
                  v-if="message.role === 'assistant' && index === messages.length - 1 && isTyping"
                  class="typing-cursor"
                >|</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useDark, useToggle, useFullscreen, useClipboard, useLocalStorage } from "@vueuse/core";
import { useVoiceChat } from "@/composables/useVoiceChat";
import { avatarSets, AVATAR_STORAGE_KEY } from "@/config/avatars";
import Swal from "sweetalert2";

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
const idleAvatar = computed(() => avatarSets[avatarIndex.value]?.idle ?? avatarSets[0].idle);
const speakingAvatar = computed(() => avatarSets[avatarIndex.value]?.speaking ?? avatarSets[0].speaking);

// 输入框
const inputText = ref("");

// 发送文字消息
const onSendText = () => {
  handleSendText(inputText.value);
  inputText.value = "";
};

// 设置弹窗：配置 clientId、deviceId、头像套装
const toggleMagic = async () => {
  const clientId = localStorage.getItem("xiaozhi_client_id") ?? "";
  const deviceId = localStorage.getItem("xiaozhi_device_id") ?? "";
  const avatarOptions = avatarSets.map((s, i) => `<option value="${i}" ${i === avatarIndex.value ? "selected" : ""}>${s.name}</option>`).join("");

  const { value } = await Swal.fire({
    title: "设置",
    html: `
      <label style="display:block;text-align:left;margin-bottom:4px;font-size:13px;color:#666">客户端 ID</label>
      <input id="swal-client" class="swal2-input" value="${clientId}" placeholder="Client ID">
      <label style="display:block;text-align:left;margin-bottom:4px;margin-top:12px;font-size:13px;color:#666">设备 ID</label>
      <input id="swal-device" class="swal2-input" value="${deviceId}" placeholder="Device ID">
      <label style="display:block;text-align:left;margin-bottom:4px;margin-top:12px;font-size:13px;color:#666">头像套装</label>
      <select id="swal-avatar" class="swal2-select">${avatarOptions}</select>
    `,
    focusConfirm: false,
    confirmButtonText: "保存",
    showCancelButton: true,
    cancelButtonText: "取消",
    preConfirm: () => ({
      clientId: (document.getElementById("swal-client") as HTMLInputElement).value,
      deviceId: (document.getElementById("swal-device") as HTMLInputElement).value,
      avatarIdx: parseInt((document.getElementById("swal-avatar") as HTMLSelectElement).value),
    }),
  });

  if (value) {
    if (value.clientId) localStorage.setItem("xiaozhi_client_id", value.clientId);
    if (value.deviceId) localStorage.setItem("xiaozhi_device_id", value.deviceId);
    avatarIndex.value = value.avatarIdx;
  }
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
  preload.forEach((src) => {
    const img = new Image();
    img.src = src;
  });
  init();
});
</script>

<style lang="scss" scoped>
@use "@/views/IndexView.scss";
</style>
