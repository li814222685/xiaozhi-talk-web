// 语音对话编排层 — 组合 WebSocket、录音、播放、消息四个模块，处理业务流程
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { useXiaozhiWebSocket } from "./useWebSocket";
import { useAudioRecorder } from "./useAudioRecorder";
import { useAudioPlayer } from "./useAudioPlayer";
import { useChatMessages } from "./useChatMessages";
import type { ServerMessage } from "@/types/messages";

export function useVoiceChat() {
  const isRecording = ref(false);
  const isPlaying = ref(false);

  const ws = useXiaozhiWebSocket();
  const recorder = useAudioRecorder();
  const player = useAudioPlayer();
  const chat = useChatMessages();

  const isDev = import.meta.env.DEV;
  const wsUrl =
    import.meta.env.VITE_WS_URL ||
    (isDev ? "/xiaozhi/v1/" : "ws://192.168.112.254:8989/xiaozhi/v1/");

  // 服务端消息路由：根据 type 分发到对应处理逻辑
  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "audio":
        // 服务端下发的 TTS 音频，送入播放器
        player.play(msg.data);
        break;

      case "stt":
        // 语音识别结果，作为用户消息展示
        if (msg.text) {
          chat.addUserMessage(msg.text);
        }
        break;

      case "tts":
        if (msg.state === "start") {
          isPlaying.value = true;
        } else if (msg.state === "stop") {
          isPlaying.value = false;
          player.stop();
          chat.finishAssistantMessage();
        } else if (msg.state === "sentence_start" && msg.text) {
          if (chat.hasCurrentAssistant()) {
            chat.appendToAssistant(msg.text);
          } else {
            chat.startAssistantMessage(msg.text);
          }
        }
        break;

      case "error": {
        const errorText = msg.message || msg.error || "未知错误";
        chat.startAssistantMessage("[错误] " + errorText);
        chat.finishAssistantMessage();
        isPlaying.value = false;
        player.stop();
        break;
      }
    }
  };

  // 开始录音：启动麦克风，每帧音频通过 WebSocket 发送，通知服务端开始监听
  const startRecording = async () => {
    if (isRecording.value) return;

    try {
      await recorder.start((buffer) => {
        ws.send(buffer);
      });
      ws.startListen("manual");
      isRecording.value = true;
    } catch {
      // getUserMedia 被拒绝
    }
  };

  // 停止录音：关闭麦克风，通知服务端停止监听
  const stopRecording = () => {
    if (!isRecording.value) return;
    ws.stopListen();
    recorder.stop();
    isRecording.value = false;
  };

  // 麦克风按钮点击：录音/停止录音/打断播放 三态切换
  const handleVoiceClick = () => {
    if (isRecording.value) {
      stopRecording();
    } else if (isPlaying.value) {
      isPlaying.value = false;
      player.stop();
      ws.abort();
    } else {
      startRecording();
    }
  };

  // 发送文字消息（不本地添加，统一由 stt 回显渲染）
  const handleSendText = (text: string) => {
    if (!text.trim() || isRecording.value || isPlaying.value) return;
    ws.sendText(text.trim());
  };

  // 初始化：注册消息监听、初始化播放器、建立 WebSocket 连接
  const init = async () => {
    ws.onMessage(handleMessage);
    await player.init();
    ws.connect(wsUrl);
  };

  const reconnect = () => {
    ws.reconnect();
  };

  // 组件卸载时清理所有资源
  tryOnScopeDispose(() => {
    recorder.stop();
    player.stop();
    ws.disconnect();
  });

  return {
    isConnected: ws.isConnected,
    isReady: ws.isReady,
    isRecording,
    isPlaying,
    messages: chat.messages,
    init,
    reconnect,
    handleVoiceClick,
    handleSendText,
  };
}
