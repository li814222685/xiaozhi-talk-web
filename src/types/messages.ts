// 服务端消息类型定义

export interface AudioParams {
  format: string;
  sample_rate: number;
  channels: number;
  frame_duration: number;
}

// 服务端下行消息（区分联合类型）
export type ServerMessage =
  | { type: "hello"; session_id: string; audio_params?: AudioParams }
  | { type: "stt"; text: string }
  | { type: "llm"; content: string }
  | { type: "tts"; state: "start" | "stop" | "sentence_start" | "sentence_end"; text?: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "error"; message?: string; error?: string }
  | { type: "abort"; reason: string };

// 聊天消息（前端展示用）
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}
