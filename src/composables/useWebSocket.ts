// WebSocket 通信层 — 基于 VueUse useWebSocket，封装小智协议握手与消息分发
import { ref } from "vue";
import {
  useWebSocket as useVueUseWebSocket,
  useLocalStorage,
} from "@vueuse/core";
import { nanoid } from "nanoid";
import type { ServerMessage } from "@/types/messages";

type MessageHandler = (msg: ServerMessage) => void;

export function useXiaozhiWebSocket() {
  // 设备标识，持久化到 localStorage
  const deviceId = useLocalStorage("xiaozhi_device_id", nanoid());
  const clientId = useLocalStorage("xiaozhi_client_id", nanoid());
  const mcpEnabled = useLocalStorage("xiaozhi_mcp_enabled", false);

  const isConnected = ref(false);
  const isReady = ref(false); // hello 握手完成后为 true
  const sessionId = ref("");

  const handlers: Set<MessageHandler> = new Set();

  let wsInstance: ReturnType<typeof useVueUseWebSocket> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let hasConnectedOnce = false;
  // 消息分发：遍历所有已注册的 handler
  const dispatchMessage = (msg: ServerMessage) => {
    handlers.forEach((handler) => handler(msg));
  };

  // MCP 消息处理：模拟设备端响应后台的 MCP 请求
  const handleMcpMessage = (msg: { session_id?: string; type: string; payload: any }) => {
    const { payload } = msg;
    if (!payload || payload.jsonrpc !== "2.0") return;

    const { method, id } = payload;

    // JSON-RPC Notification（无 id）：静默处理，不回复
    // 例如后台在 initialize 成功后发送 notifications/initialized
    if (id === undefined || id === null) {
      console.log("[MCP] notification:", method);
      return;
    }

    const sendMcpResponse = (result: any) => {
      send(
        JSON.stringify({
          session_id: sessionId.value,
          type: "mcp",
          payload: { jsonrpc: "2.0", id, result },
        })
      );
    };

    switch (method) {
      case "initialize":
        sendMcpResponse({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "xiaozhi-web-mock", version: "1.0.0" },
        });
        break;

      case "tools/list":
        sendMcpResponse({
          tools: [
            {
              name: "self.robot.navigate",
              description:
                "仅当用户明确命令机器人带路、导航到室内地点时使用；不要用于用户陈述自己行程安排（如「我下午要去会议室」「我去坐电梯」）或闲聊。参数 poi_name 为目的地名称或描述。",
              inputSchema: {
                type: "object",
                properties: { poi_name: { type: "string" } },
                required: ["poi_name"],
              },
            },
            {
              name: "self.robot.query_poi",
              description: "返回当前地图全部 POI 列表，无参数。每项含 poi_name字段",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
            {
              name: "self.robot.current_pose",
              description:
                "返回机器人当前位姿，无参数。字段：floor、x、y。在多个 POI 候选需按距离或同层优先选择时可调用；一般不必每次对话都调，优先使用服务端已缓存的最新位姿。",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        });
        break;

      case "tools/call": {
        const toolName = payload.params?.name;
        let resultText = "true";

        if (toolName === "self.robot.query_poi") {
          resultText = JSON.stringify({
            mapPoi: [
              { name: "调试台", type: "work", floor: "7", x: 1.677, y: -0.878 },
              { name: "test", type: "work", floor: "7", x: -3.354, y: -0.739 },
              { name: "door1", type: "work", floor: "7", x: -5.307, y: 7.805 },
              { name: "desk", type: "work", floor: "7", x: 7.068, y: -0.648 },
              { name: "开关", type: "work", floor: "7", x: -0.820, y: 2.142 },
              { name: "前台", type: "work", floor: "7", x: -3.236, y: -4.054 },
              { name: "机房", type: "work", floor: "7", x: 5.447, y: 1.736 },
              { name: "716会议室", type: "work", floor: "7", x: -6.570, y: 2.200 },
              { name: "茶水间", type: "work", floor: "7", x: -1.771, y: 5.036 },
              { name: "实验室1", type: "work", floor: "7", x: -3.771, y: 4.036 },
              { name: "实验室2", type: "work", floor: "7", x: -5.771, y: 8.036 },
            ],
          });
        }

        sendMcpResponse({
          content: [{ type: "text", text: resultText }],
          isError: false,
        });
        break;
      }

      default:
        send(
          JSON.stringify({
            session_id: sessionId.value,
            type: "mcp",
            payload: {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown method: ${method}` },
            },
          })
        );
    }
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
          // 首次连接发 hello 文本触发欢迎语，重连时跳过
          if (!hasConnectedOnce) {
            hasConnectedOnce = true;
            send(
              JSON.stringify({
                session_id: sessionId.value,
                type: "listen",
                state: "detect",
                text: "hello",
              })
            );
          }
        }
        // MCP 消息：后台发来的工具请求，模拟设备端响应
        if (msg.type === "mcp") {
          handleMcpMessage(msg);
          return;
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
      autoReconnect: { retries: 10, delay: 3000 },
      autoClose: false,
      onConnected(ws) {
        console.log("[WS] 已连接");
        ws.binaryType = "arraybuffer";
        isConnected.value = true;

        // 心跳保活：每 15s 发一次，防止服务端超时断开
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15000);

        ws.send(
          JSON.stringify({
            type: "hello",
            version: 1,
            transport: "websocket",
            features: { mcp: mcpEnabled.value },
            audio_params: {
              format: "opus",
              sample_rate: 16000,
              channels: 1,
              frame_duration: 60,
            },
          })
        );

      },
      onDisconnected(_, event) {
        console.log("[WS] 断开连接:", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        isConnected.value = false;
        isReady.value = false;
        sessionId.value = "";
      },
      onError(ws, event) {
        console.error("[WS] WebSocket 发生错误:", {
          type: event.type,
          target: ws.url,
          readyState: ws.readyState,
          timestamp: new Date().toISOString(),
        });
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
    console.log("[WS] disconnect() 被调用");
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    wsInstance?.close();
    isConnected.value = false;
    isReady.value = false;
  };

  // 重置状态并重新发起连接
  const reconnect = () => {
    console.log("reconnect");
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
