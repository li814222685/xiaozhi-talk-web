# xiaozhi-talk-web

小智 AI 语音对话 Web 客户端。通过 WebSocket 连接小智服务端，支持实时语音和文字对话。

## 技术栈

Vue 3 + TypeScript + Vite，音频编码走 WebCodecs（Opus），解码走 WASM（opus-decoder），全程 AudioWorklet 处理。

## 运行

```bash
pnpm install
pnpm dev
```

默认启用 HTTPS（自签名证书），访问 `https://localhost:5173`。局域网内其他设备通过 IP 访问时浏览器会提示证书不信任，点继续即可。

## 配置

`vite.config.ts` 中 proxy 配置 WebSocket 代理地址，指向小智服务端：

```ts
proxy: {
  "/xiaozhi": {
    target: "ws://192.168.112.254:8989",
    ws: true,
    changeOrigin: true,
  },
}
```

生产环境通过 `VITE_WS_URL` 环境变量指定 WS 地址。

## 浏览器要求

- Chrome / Edge 94+（依赖 WebCodecs AudioEncoder）
- 必须 HTTPS 或 localhost（AudioWorklet + 麦克风权限需要安全上下文）
