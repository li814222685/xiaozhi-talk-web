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
              <p class="message-content">{{ message.content }}</p>
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
import { ref, onMounted } from "vue";
import { useDark, useToggle, useFullscreen, useClipboard } from "@vueuse/core";
import { useVoiceChat } from "@/composables/useVoiceChat";

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
  messages,
  init,
  reconnect,
  handleVoiceClick,
  handleSendText,
} = useVoiceChat();

// 输入框 & 头像资源
const inputText = ref("");
const idleAvatar = "/src/assets/webp/hlw1.webp";
const speakingAvatar = "/src/assets/webp/hlw2.webp";

// 发送文字消息
const onSendText = () => {
  handleSendText(inputText.value);
  inputText.value = "";
};

// 预留功能
const toggleMagic = () => {};

// 分享：复制当前页面链接
const shareApp = () => {
  copy(window.location.href);
};

// 组件挂载：预加载头像图片，初始化 WebSocket 连接
onMounted(() => {
  const preload = [idleAvatar, speakingAvatar];
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
