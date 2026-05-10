import { ref } from "vue";
import type { ChatMessage } from "@/types/messages";

export function useChatMessages() {
  const messages = ref<ChatMessage[]>([]);
  let currentAssistantId: string | null = null;

  const createId = (): string => {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  };

  const addUserMessage = (content: string) => {
    messages.value.push({
      id: createId(),
      role: "user",
      content,
      timestamp: Date.now(),
    });
  };

  const startAssistantMessage = (content = ""): string => {
    const id = createId();
    messages.value.push({
      id,
      role: "assistant",
      content,
      timestamp: Date.now(),
    });
    currentAssistantId = id;
    return id;
  };

  const appendToAssistant = (text: string) => {
    if (!currentAssistantId) {
      startAssistantMessage(text);
      return;
    }

    const msg = messages.value.find((m) => m.id === currentAssistantId);
    if (msg) {
      if (!msg.content.endsWith(text)) {
        msg.content += text;
      }
    }
  };

  const finishAssistantMessage = () => {
    currentAssistantId = null;
  };

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
