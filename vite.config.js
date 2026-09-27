import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The desktop client falls back to loading dist/index.html directly when
  // the API is stopped. Relative asset URLs keep that file:// entry point
  // working in the packaged Electron app.
  base: './',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  }
});
