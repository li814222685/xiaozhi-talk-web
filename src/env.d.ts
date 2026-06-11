/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "*.webp" {
  const src: string;
  export default src;
}

declare module "@met4citizen/talkinghead" {
  export class TalkingHead {
    constructor(container: HTMLElement, options?: any);
    audioCtx: AudioContext;
    audioSpeechGainNode: GainNode;
    audioStreamGainNode: GainNode;
    mtAvatar: Record<string, any>;
    opt: Record<string, any>;
    showAvatar(avatar: any, onprogress?: any): Promise<void>;
    streamStart(opt?: any, onAudioStart?: any, onAudioEnd?: any, onSubtitles?: any, onMetrics?: any): Promise<void>;
    streamAudio(r: { audio: ArrayBuffer; visemes?: number[]; vtimes?: number[]; vdurations?: number[] }): void;
    streamNotifyEnd(): void;
    streamInterrupt(): void;
    streamStop(): void;
    start(): void;
    stop(): void;
  }
}

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
