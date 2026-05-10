// 聊天消息状态管理 — 维护消息列表，支持流式 assistant 消息打字机效果
import { ref } from "vue";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@/types/messages";

export function useChatMessages() {
  const messages = ref<ChatMessage[]>([]);
  const isTyping = ref(false);
  let currentAssistantId: string | null = null;
  let typeQueue: string[] = [];
  let typeTimer: ReturnType<typeof setTimeout> | null = null;

  // 逐字渲染队列中的文本
  const processTypeQueue = () => {
    if (typeQueue.length === 0) {
      isTyping.value = false;
      typeTimer = null;
      return;
    }

    const char = typeQueue.shift()!;
    const msg = messages.value.find((m) => m.id === currentAssistantId);
    if (msg) {
      msg.content += char;
    }

    typeTimer = setTimeout(processTypeQueue, 80);
  };

  // 添加用户消息
  const addUserMessage = (content: string) => {
    messages.value.push({
      id: nanoid(),
      role: "user",
      content,
      timestamp: Date.now(),
    });
  };

  // 进入等待状态：创建空 assistant 消息，光标开始闪烁
  const startWaiting = () => {
    if (currentAssistantId) return;
    const id = nanoid();
    messages.value.push({
      id,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    });
    currentAssistantId = id;
    isTyping.value = true;
  };

  // 开始一条新的 assistant 消息（流式场景下先创建空消息）
  const startAssistantMessage = (content = ""): string => {
    // 如果已经在等待状态，复用已有消息
    if (currentAssistantId) {
      if (content) {
        for (const char of content) {
          typeQueue.push(char);
        }
        if (!typeTimer) {
          isTyping.value = true;
          processTypeQueue();
        }
      }
      return currentAssistantId;
    }

    const id = nanoid();
    messages.value.push({
      id,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    });
    currentAssistantId = id;
    // 如果有初始内容，走打字机
    if (content) {
      for (const char of content) {
        typeQueue.push(char);
      }
      if (!typeTimer) {
        isTyping.value = true;
        processTypeQueue();
      }
    }
    return id;
  };

  // 追加文本到当前 assistant 消息（打字机效果，80ms/字）
  const appendToAssistant = (text: string) => {
    if (!currentAssistantId) {
      startAssistantMessage(text);
      return;
    }

    for (const char of text) {
      typeQueue.push(char);
    }

    if (!typeTimer) {
      isTyping.value = true;
      processTypeQueue();
    }
  };

  // 结束当前 assistant 消息，立即完成剩余打字
  const finishAssistantMessage = () => {
    if (typeTimer) {
      clearTimeout(typeTimer);
      typeTimer = null;
    }
    if (typeQueue.length > 0 && currentAssistantId) {
      const msg = messages.value.find((m) => m.id === currentAssistantId);
      if (msg) {
        msg.content += typeQueue.join("");
      }
      typeQueue = [];
    }
    isTyping.value = false;
    currentAssistantId = null;
  };

  // 是否正在接收流式 assistant 消息
  const hasCurrentAssistant = (): boolean => currentAssistantId !== null;

  return {
    messages,
    isTyping,
    addUserMessage,
    startWaiting,
    startAssistantMessage,
    appendToAssistant,
    finishAssistantMessage,
    hasCurrentAssistant,
  };
}
