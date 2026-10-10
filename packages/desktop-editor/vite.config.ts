import { defineConfig } from "vite";

// Builds the editor host into ../desktop/ui/editor-host/, served by the daemon.
export default defineConfig({
  base: "/editor-host/",
  build: {
    target: "esnext",
    outDir: "../desktop/ui/editor-host",
    emptyOutDir: true,
    lib: undefined,
    rollupOptions: { input: "src/main.ts", output: { entryFileNames: "editor-host.js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } },
    chunkSizeWarningLimit: 20000,
  },
  worker: { format: "es" },
  plugins: [{
    // VS Code's CSS is loaded as strings, as monaco-vscode-api requires.
    name: "load-vscode-css-as-string",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, options);
      if (resolved && /node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) return { ...resolved, id: resolved.id + "?inline" };
      return undefined;
    },
  }],
  resolve: { dedupe: ["vscode", "monaco-editor"] },
});
