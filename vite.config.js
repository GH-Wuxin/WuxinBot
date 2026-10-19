import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The desktop client falls back to loading dist/index.html directly when
  // the API is stopped. Relative asset URLs keep that file:// entry point
  // working in the packaged Electron app.
  base: './',
  server: {
    // 原子写会留下短暂的 .tmp 目录，Windows 上 chokidar 会 EBUSY；轮询更稳。
    watch: { usePolling: true, interval: 200 },
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  }
});
