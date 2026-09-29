import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The dashboard is a static bundle served by @scope-ai/server. In development, `vite` serves it
// and proxies the API to a running `scope ui` (default http://127.0.0.1:4700).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages resolve to their TypeScript sources (docs/decisions/0001).
  resolve: { conditions: ['scope-source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: { '/api': process.env.SCOPE_API_URL ?? 'http://127.0.0.1:4700' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Everything is local: fonts and assets are files (never inlined), which a strict CSP allows.
    assetsInlineLimit: 0,
  },
});
