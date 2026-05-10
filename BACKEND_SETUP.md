# xiaozhi-esp32-server 本地部署指南

> 目标：在本地跑起 xiaozhi-esp32-server，让 xiaozhi-talk-web 前端直接对接上。
> 使用阿里百炼（DashScope）作为 LLM / ASR / TTS 提供商。

---

## 前置条件

- Docker + Docker Compose
- 阿里云百炼平台 API Key（免费注册即可获得额度）
  - 注册地址：https://bailian.console.aliyun.com/
  - 开通模型服务后，在「API-KEY管理」中创建 Key

---

## Step 1：克隆项目

```bash
git clone https://github.com/xinnan-tech/xiaozhi-esp32-server.git
cd xiaozhi-esp32-server
```

---

## Step 2：一键部署（推荐）

项目提供了一键部署脚本：

```bash
bash docker-setup.sh
```

脚本会自动：
1. 拉取 Docker 镜像
2. 创建配置文件模板
3. 启动所有服务（Redis、MySQL、Server、Web 管理后台）

如果脚本执行有问题，也可以手动操作（见下方）。

---

## Step 3：手动部署（备选）

```bash
# 复制配置文件模板
cp .env.example .env

# 启动服务
docker compose up -d
```

---

## Step 4：配置 AI 服务

启动后，访问 Web 管理后台（默认 http://localhost:8002），在后台界面中配置：

### LLM（大语言模型）
- 类型选择：`openai`（兼容 OpenAI 格式）
- API Base：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- API Key：你的百炼 API Key
- Model：`qwen-plus` 或 `qwen-turbo`（按需选择）

### ASR（语音识别）
- 类型选择：`aliyun` 或 `dashscope`
- API Key：同上
- 支持的模型：`paraformer-realtime-v2`（实时流式识别）

### TTS（语音合成）
- 类型选择：`aliyun` 或 `cosyvoice`
- API Key：同上
- 支持的模型：`cosyvoice-v1`（自然语音）
- Voice：`longxiaochun`（龙小淳）等预置音色

---

## Step 5：确认服务端口

| 服务 | 端口 | 用途 |
|------|------|------|
| WebSocket Server | **8000** (或 8989) | 前端 WebSocket 对接地址 |
| Web 管理后台 | **8002** | 配置 LLM/ASR/TTS |
| Redis | 6379 | 会话缓存 |
| MySQL | 3306 | 数据存储 |

> 注意：具体端口以项目 docker-compose.yml 中的配置为准，不同版本可能有差异。

---

## Step 6：前端对接

修改 `xiaozhi-talk-web/vite.config.ts` 中的 proxy 目标地址：

```typescript
proxy: {
  "/xiaozhi": {
    target: "ws://localhost:8000",  // 改为你本地 server 的实际端口
    ws: true,
    changeOrigin: true,
  },
},
```

或者直接设置环境变量：

```bash
# 在 xiaozhi-talk-web 目录下创建 .env.local
VITE_WS_URL=/xiaozhi/v1/
```

然后启动前端：

```bash
cd xiaozhi-talk-web
pnpm install
pnpm dev
```

打开 http://localhost:5173，应该能看到状态变为「在线」，即对接成功。

---

## 通信协议说明

前端和后端之间的 WebSocket 协议已经是匹配的，不需要额外适配：

```
前端连接: ws://localhost:8000/xiaozhi/v1/?device-id=xxx&client-id=xxx

1. 前端发送 hello → 后端回复 hello（含 session_id）
2. 前端发送 listen start → 开始发送音频流（PCM Float32）
3. 后端返回 stt（识别文本）→ llm（回复内容）→ tts（语音状态）→ audio（音频流）
4. 前端发送 listen stop → 停止录音
```

---

## 常见问题

### Q: 连接后状态一直是「连接中」？
- 检查 docker 服务是否正常运行：`docker compose ps`
- 检查端口是否正确
- 查看日志：`docker compose logs -f server`

### Q: 能连接但没有语音回复？
- 检查管理后台中 ASR/LLM/TTS 的 API Key 是否配置正确
- 查看 server 日志中是否有 API 调用错误

### Q: 音频格式不匹配？
- xiaozhi-esp32-server 支持 PCM 和 Opus 格式
- 前端 hello 消息中声明了 `format: "pcm"`，服务端会据此处理
- 如果需要 Opus，修改前端 hello 中的 audio_params.format

---

## 参考链接

- 项目仓库：https://github.com/xinnan-tech/xiaozhi-esp32-server
- 部署文档：https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/docs/Deployment.md
- 完整部署（含所有依赖）：https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/docs/Deployment_all.md
- 阿里百炼平台：https://bailian.console.aliyun.com/
- DashScope API 文档：https://help.aliyun.com/zh/model-studio/dashscope-api-reference/
