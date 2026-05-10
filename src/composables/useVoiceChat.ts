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

  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "audio":
        player.play(msg.data);
        break;

      case "stt":
        if (msg.text) {
          chat.addUserMessage(msg.text);
        }
        break;

      case "llm":
        if (msg.content) {
          chat.startAssistantMessage(msg.content);
        }
        break;

      case "tts":
        if (msg.state === "start") {
          isPlaying.value = true;
        } else if (msg.state === "stop") {
          isPlaying.value = false;
          player.stop();
          chat.finishAssistantMessage();
        } else if (msg.state === "sentence_end" && msg.text) {
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

  const startRecording = async () => {
    if (isRecording.value) return;

    try {
      await recorder.start((buffer) => {
        ws.send(buffer);
      });
      ws.startListen("manual");
      isRecording.value = true;
    } catch {
      // getUserMedia denied
    }
  };

  const stopRecording = () => {
    if (!isRecording.value) return;
    ws.stopListen();
    recorder.stop();
    isRecording.value = false;
  };

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

  const handleSendText = (text: string) => {
    if (!text.trim() || isRecording.value || isPlaying.value) return;
    chat.addUserMessage(text.trim());
    ws.sendText(text.trim());
  };

  const init = async () => {
    ws.onMessage(handleMessage);
    await player.init();
    ws.connect(wsUrl);
  };

  const reconnect = () => {
    ws.reconnect();
  };

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
