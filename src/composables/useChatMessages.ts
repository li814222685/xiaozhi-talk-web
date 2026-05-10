// 聊天消息状态管理 — 维护消息列表，支持流式 assistant 消息拼接
import { ref } from "vue";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@/types/messages";

export function useChatMessages() {
  const messages = ref<ChatMessage[]>([]);
  let currentAssistantId: string | null = null;

  // 添加用户消息
  const addUserMessage = (content: string) => {
    messages.value.push({
      id: nanoid(),
      role: "user",
      content,
      timestamp: Date.now(),
    });
  };

  // 开始一条新的 assistant 消息（流式场景下先创建空消息）
  const startAssistantMessage = (content = ""): string => {
    const id = nanoid();
    messages.value.push({
      id,
      role: "assistant",
      content,
      timestamp: Date.now(),
    });
    currentAssistantId = id;
    return id;
  };

  // 追加文本到当前 assistant 消息（TTS 流式逐句拼接）
  const appendToAssistant = (text: string) => {
    if (!currentAssistantId) {
      startAssistantMessage(text);
      return;
    }

    const msg = messages.value.find((m) => m.id === currentAssistantId);
    if (msg) {
      // 去重：避免同一段文字被重复追加
      if (!msg.content.endsWith(text)) {
        msg.content += text;
      }
    }
  };

  // 结束当前 assistant 消息
  const finishAssistantMessage = () => {
    currentAssistantId = null;
  };

  // 是否正在接收流式 assistant 消息
  const hasCurrentAssistant = (): boolean => currentAssistantId !== null;

  return {
    messages,
    addUserMessage,
    startAssistantMessage,
    appendToAssistant,
    finishAssistantMessage,
    hasCurrentAssistant,
  };
}
