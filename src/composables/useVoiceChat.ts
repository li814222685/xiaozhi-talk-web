// 语音对话编排层 — 组合 WebSocket、录音、播放、消息四个模块，处理业务流程
import { ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import { useXiaozhiWebSocket } from "./useWebSocket";
import { useAudioRecorder } from "./useAudioRecorder";
import { useAudioPlayer } from "./useAudioPlayer";
import { useChatMessages } from "./useChatMessages";
import { useTalkingHead } from "./useTalkingHead";
import { useVisemeDriver } from "./useVisemeDriver";
import { useLipSyncMetrics } from "./useLipSyncMetrics";
import type { ServerMessage } from "@/types/messages";

export function useVoiceChat(avatarContainerRef: () => HTMLElement | null) {
  const isRecording = ref(false);
  const isPlaying = ref(false);
  const ttsFinished = ref(false);
  // 最后一帧音频"入队"时刻（ms）。批测据此判断整段播报是否真正静默，
  // 比依赖 isPlaying 的 true/false 边沿可靠（边沿会被句间排空、短回复错过）。
  const lastAudioAt = ref(0);
  let endedTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTextSends = 0;
  let audioFrameCount = 0;

  const ws = useXiaozhiWebSocket();
  const recorder = useAudioRecorder();
  const player = useAudioPlayer();
  const chat = useChatMessages();
  const talkingHead = useTalkingHead(avatarContainerRef);
  const visemeDriver = useVisemeDriver({
    getCurrentTime: () => player.getCurrentTime(),
  });
  const lipsyncMetrics = useLipSyncMetrics();

  const isDev = import.meta.env.DEV;
  const getWsUrl = () => {
    const saved = localStorage.getItem("xiaozhi_ws_url");
    if (saved) return saved;
    if (isDev) return "/xiaozhi/v1/";
    return "ws://192.168.112.254:8989/xiaozhi/v1/";
  };

  // 服务端消息路由：根据 type 分发到对应处理逻辑
  const handleMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "audio":
        // 收到音频帧，取消超时计时器
        if (endedTimer) {
          clearTimeout(endedTimer);
          endedTimer = null;
        }
        if (!isPlaying.value) {
          isPlaying.value = true;
          ttsFinished.value = false;
        }
        lastAudioAt.value = Date.now();
        player.play(msg.data);

        // 每帧音频都驱动一次 visemeDriver，让嘴型按 player 的时钟前进。
        // 真实音频由 player 播放；TalkingHead 走空 PCM（gain 已置 0 不出声），
        // 只为驱动其内部 update 回调做 morph 插值。
        if (talkingHead.isReady.value && visemeDriver.isActive.value) {
          audioFrameCount++;
          const diag = visemeDriver.tickWithDiag();
          const silentPcm = new Float32Array(960); // 60ms @ 16kHz
          talkingHead.streamAudioWithViseme(
            silentPcm,
            diag.viseme,
            diag.intensity
          );
          lipsyncMetrics.onFrame(
            audioFrameCount,
            diag.viseme,
            diag.progress,
            diag.totalFrames
          );
        }
        break;

      case "stt":
        // 语音识别结果：文字输入已在本地添加，跳过服务端回显
        if (msg.text) {
          if (pendingTextSends > 0) {
            pendingTextSends--;
          } else {
            chat.addUserMessage(msg.text);
            chat.startWaiting();
          }
        }
        break;

      case "tts":
        if (msg.state === "start") {
          player.resume();
          ttsFinished.value = false;
          talkingHead.streamStart();
        } else if (msg.state === "stop") {
          ttsFinished.value = true;
          chat.finishAssistantMessage();
          talkingHead.streamEnd();
          visemeDriver.reset();
        } else if (msg.state === "sentence_start" && msg.text) {
          if (chat.hasCurrentAssistant()) {
            chat.appendToAssistant(msg.text);
          } else {
            chat.startAssistantMessage(msg.text);
          }
          // 服务端下发 timedVisemes 时启动 viseme driver；没下发就只显示文本不驱动嘴型
          visemeDriver.onSentenceStart(msg.timedVisemes);
          audioFrameCount = 0;
          const state = visemeDriver.getState();
          if (state.timedVisemes.length > 0) {
            lipsyncMetrics.onSentenceStart(
              msg.text || "",
              state.timedVisemes.map((v) => v.shape),
              state.totalFrames
            );
          }
        } else if (msg.state === "sentence_end") {
          visemeDriver.onSentenceEnd();
          lipsyncMetrics.onSentenceEnd();
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

  // 开始录音：启动麦克风，auto 模式持续发送音频帧，服务端 VAD 自动断句
  const startRecording = async () => {
    if (isRecording.value) return;

    try {
      await recorder.start((buffer) => {
        ws.send(buffer);
      });
      ws.startListen("auto");
      isRecording.value = true;
    } catch {
      // getUserMedia 被拒绝
    }
  };

  // 停止录音：关闭麦克风（auto 模式无需发 stop，服务端 VAD 自动处理）
  const stopRecording = () => {
    if (!isRecording.value) return;
    recorder.stop();
    isRecording.value = false;
  };

  // 麦克风按钮点击：录音/停止录音
  const handleVoiceClick = () => {
    player.resume();
    if (isRecording.value) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // 发送文字消息（本地立即添加用户消息，不依赖服务端 stt 回显）
  const handleSendText = (text: string) => {
    if (!text.trim() || isRecording.value) return;

    // 如果正在播放，打断当前回复
    if (isPlaying.value) {
      ws.abort();
      player.stop();
      talkingHead.streamInterrupt();
      visemeDriver.reset();
      chat.finishAssistantMessage();
      isPlaying.value = false;
      ttsFinished.value = false;
      if (endedTimer) {
        clearTimeout(endedTimer);
        endedTimer = null;
      }
    }

    player.resume();
    chat.addUserMessage(text.trim());
    chat.startWaiting();
    pendingTextSends++;
    ws.sendText(text.trim());
  };

  // 初始化：注册消息监听、初始化播放器、建立 WebSocket 连接
  const init = async () => {
    ws.onMessage(handleMessage);
    await player.init();

    // 初始化 TalkingHead lip sync
    await talkingHead.init();

    // 音频队列播放完毕时判断是否恢复状态
    player.onEnded(() => {
      if (ttsFinished.value) {
        isPlaying.value = false;
        // TTS 播放完毕，自动开启下一轮监听
        ws.startListen("auto");
      } else {
        // 未收到 tts stop，启动超时兜底（1.5s 内无新音频则恢复）
        endedTimer = setTimeout(() => {
          isPlaying.value = false;
        }, 1500);
      }
    });
    ws.connect(getWsUrl());
  };

  const reconnect = () => {
    ws.reconnect();
  };

  // 组件卸载时清理所有资源
  tryOnScopeDispose(() => {
    recorder.stop();
    player.stop();
    talkingHead.destroy();
    ws.disconnect();
  });

  return {
    isConnected: ws.isConnected,
    isReady: ws.isReady,
    isRecording,
    isPlaying,
    isMuted: player.isMuted,
    setMuted: player.setMuted,
    isTtsFinished: ttsFinished,
    lastAudioAt,
    isTyping: chat.isTyping,
    messages: chat.messages,
    isTalkingHeadReady: talkingHead.isReady,
    lipsyncMetrics,
    setCamera: talkingHead.setCamera,
    init,
    reconnect,
    disconnect: ws.disconnect,
    handleVoiceClick,
    handleSendText,
  };
}
