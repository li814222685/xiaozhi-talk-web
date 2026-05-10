import { ref } from "vue";
import {
  useWebSocket as useVueUseWebSocket,
  useLocalStorage,
} from "@vueuse/core";
import type { ServerMessage } from "@/types/messages";

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
  const deviceId = useLocalStorage("xiaozhi_device_id", generateUUID());
  const clientId = useLocalStorage("xiaozhi_client_id", generateUUID());

  const isConnected = ref(false);
  const isReady = ref(false);
  const sessionId = ref("");

  const handlers: Set<MessageHandler> = new Set();

  let wsInstance: ReturnType<typeof useVueUseWebSocket> | null = null;

  const dispatchMessage = (msg: ServerMessage) => {
    handlers.forEach((handler) => handler(msg));
  };

  const handleRawData = (data: string | ArrayBuffer | Blob) => {
    if (data instanceof ArrayBuffer) {
      dispatchMessage({ type: "audio", data });
      return;
    }

    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
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
        ws.binaryType = "arraybuffer";
        isConnected.value = true;

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

  const send = (data: ArrayBuffer | string) => {
    if (wsInstance?.ws.value?.readyState === WebSocket.OPEN) {
      wsInstance.ws.value.send(data);
    }
  };

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

  const stopListen = () => {
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "listen",
        state: "stop",
      })
    );
  };

  const abort = (reason = "user_request") => {
    send(
      JSON.stringify({
        session_id: sessionId.value,
        type: "abort",
        reason,
      })
    );
  };

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

  const onMessage = (handler: MessageHandler) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };

  const disconnect = () => {
    wsInstance?.close();
    isConnected.value = false;
    isReady.value = false;
  };

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
