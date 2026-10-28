import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import type { IncomingMessage } from 'node:http';

const spaBypass = (req: IncomingMessage) =>
  req.headers.accept?.includes('text/html') ? '/index.html' : null;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: spaBypass,
      },
      '/workspaces': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: spaBypass,
      },
      '/endpoints': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: spaBypass,
      },
      '/events': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: spaBypass,
      },
      '/in': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: true,
  },
});
