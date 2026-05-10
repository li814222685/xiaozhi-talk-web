export interface AudioParams {
  format: string;
  sample_rate: number;
  channels: number;
  frame_duration: number;
}

export type ServerMessage =
  | { type: "hello"; session_id: string; audio_params?: AudioParams }
  | { type: "stt"; text: string }
  | { type: "llm"; content: string }
  | { type: "tts"; state: "start" | "stop" | "sentence_end"; text?: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "error"; message?: string; error?: string }
  | { type: "abort"; reason: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}
