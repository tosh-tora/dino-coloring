import { defineConfig } from "vite";

// base "./" so the built site works on any static host path (GitHub Pages のサブパス等)
export default defineConfig({
  base: "./",
  server: {
    host: true,
  },
});
