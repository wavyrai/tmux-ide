import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "./",
  plugins: [
    solid(),
    {
      name: "desktop-preview-hmr-policy",
      apply: "serve",
      transformIndexHtml(html) {
        return html.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173");
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
