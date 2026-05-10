import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/xiaozhi": {
        target: "ws://192.168.31.30:8000/xiaozhi/v1/", //全套本地仿真服务
        // target: "ws://192.168.112.213:5002", python本地代理
        // target: "ws://192.168.112.254:8989",     服务器
        //   // target: "ws://192.168.112.109:8989",   后端本地
        ws: true,
        changeOrigin: true,
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/assets/styles/variables.scss" as *; @use "@/assets/styles/_mixins.scss" as *;`,
      },
    },
  },
});
