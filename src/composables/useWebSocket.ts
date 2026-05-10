// WebSocket 通信层 — 基于 VueUse useWebSocket，封装小智协议握手与消息分发
import { ref } from "vue";
import {
  useWebSocket as useVueUseWebSocket,
  useLocalStorage,
} from "@vueuse/core";
import type { ServerMessage } from "@/types/messages";

// 生成 UUID v4，用于设备标识
function generateUUID(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type MessageHandler = (msg: ServerMessage) => void;

export function useXiaozhiWebSocket() {
  // 设备标识，持久化到 localStorage
  const deviceId = useLocalStorage("xiaozhi_device_id", generateUUID());
  const clientId = useLocalStorage("xiaozhi_client_id", generateUUID());

  const isConnected = ref(false);
  const isReady = ref(false); // hello 握手完成后为 true
  const sessionId = ref("");

  const handlers: Set<MessageHandler> = new Set();

  let wsInstance: ReturnType<typeof useVueUseWebSocket> | null = null;

  // 消息分发：遍历所有已注册的 handler
  const dispatchMessage = (msg: ServerMessage) => {
    handlers.forEach((handler) => handler(msg));
  };

  // 解析原始数据，区分二进制音频和 JSON 文本消息
  const handleRawData = (data: string | ArrayBuffer | Blob) => {
    if (data instanceof ArrayBuffer) {
      dispatchMessage({ type: "audio", data });
      return;
    }

    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        // hello 响应标志着握手完成，提取 session_id
        if (msg.type === "hello") {
          sessionId.value = msg.session_id ?? "";
          isReady.value = true;
        }
        dispatchMessage(msg as ServerMessage);
      } catch {
        dispatchMessage({ type: "error", message: "Failed to parse message" });
      }
    }
  };

  // 建立 WebSocket 连接，附加设备标识参数，连接后发送 hello 握手
  const connect = (url: string) => {
    const fullUrl = url.includes("?")
      ? `${url}&device-id=${deviceId.value}&client-id=${clientId.value}`
      : `${url}?device-id=${deviceId.value}&client-id=${clientId.value}`;

    wsInstance = useVueUseWebSocket(fullUrl, {
      autoReconnect: {
        retries: 5,
        delay: 1000,
      },
      onConnected(ws) {
        // 必须设为 arraybuffer，否则二进制数据会被转为 Blob
        ws.binaryType = "arraybuffer";
        isConnected.value = true;

        // 发送 hello 握手，告知服务端音频参数
        ws.send(
          JSON.stringify({
            type: "hello",
            version: 1,
            transport: "websocket",
            features: { mcp: false },
            audio_params: {
              format: "pcm",
              sample_rate: 16000,
              channels: 1,
              frame_duration: 60,
            },
          })
        );
      },
      onDisconnected() {
        isConnected.value = false;
        isReady.value = false;
      },
      onMessage(_ws, event) {
        handleRawData(event.data);
      },
    });
  };

  // 发送原始数据（音频帧或 JSON 命令）
  const send = (data: ArrayBuffer | string) => {
    if (wsInstance?.ws.value?.readyState === WebSocket.OPEN) {
      wsInstance.ws.value.send(data);
    }
  };

  // 通知服务端开始监听（用户按下麦克风）
  const startListen = (mode: "auto" | "manual" | "realtime" = "manual") => {
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "listen",
        state: "start",
        mode,
      })
    );
  };

  // 通知服务端停止监听（用户松开麦克风）
  const stopListen = () => {
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "listen",
        state: "stop",
      })
    );
  };

  // 中止当前对话（打断 TTS 播放）
  const abort = (reason = "user_request") => {
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "abort",
        reason,
      })
    );
  };

  // 发送文字输入（不走语音通道）
  const sendText = (text: string) => {
    if (!isReady.value || !sessionId.value) return;
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "listen",
        state: "detect",
        mode: "manual",
        text,
      })
    );
  };

  // 注册消息处理回调，返回注销函数
  const onMessage = (handler: MessageHandler) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  const disconnect = () => {
    wsInstance?.close();
    isConnected.value = false;
    isReady.value = false;
  };

  // 重置状态并重新发起连接
  const reconnect = () => {
    if (wsInstance) {
      isReady.value = false;
      sessionId.value = "";
      wsInstance.open();
    }
  };

  return {
    isConnected,
    isReady,
    sessionId,
    connect,
    send,
    sendText,
    startListen,
    stopListen,
    abort,
    onMessage,
    disconnect,
    reconnect,
  };
}
