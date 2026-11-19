import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import checker from "vite-plugin-checker";
import path from "path";
import wasm from 'vite-plugin-wasm';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';

// GoatCounter page views (cookie-free), only in the build Render makes for the live demo.
// Render sets RENDER=true during its builds, so local builds and release zips have no tracker.
// Each hit is tagged with the host, so every deployed app shows up separately on one dashboard.
const goatCounterOnRender = (): Plugin => ({
  name: "goatcounter-on-render",
  apply: "build",
  transformIndexHtml() {
    if (process.env.RENDER !== "true") return;
    return [
      { tag: "script", children: "window.goatcounter={path:function(p){return location.host+p}}", injectTo: "body" },
      { tag: "script", attrs: { "data-goatcounter": "https://geekcc.goatcounter.com/count", async: true, src: "//gc.zgo.at/count.js" }, injectTo: "body" }
    ];
  }
});

// https://vitejs.dev/config/
export default defineConfig({
  assetsInclude: ['**/*.wasm', '**/*.onnx', '**/*.json'],
  base: "./",
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    compress: true, // Enable Gzip or Brotli compression for faster serving of static files
    middlewareMode: true, // Enables middleware mode for customization
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp"); 
        next(); // Proceed to the next middleware
      });
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
    esbuildOptions: {
      plugins: [NodeGlobalsPolyfillPlugin({ buffer: true })]
    }
  },
  plugins: [
    react(), 
    checker({ typescript: true }),
    wasm(),
    goatCounterOnRender()
  ],
  build: {
    target: "esnext", // Target modern JavaScript for optimization
    outDir: "dist", // Output directory for production files
    assetsInlineLimit: 0, // Ensure assets like WASM files are not inlined but kept as external files
    minify: "terser", // Enable minification using Terser (default for Vite)
    rollupOptions: { // Rollup-specific configuration for file naming and chunking
      output: {
        entryFileNames: "assets/[name].[hash].js", // Customize file names for entry and chunk files
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: (assetInfo) => { 
          return "assets/[name].[hash][extname]"; // Handle other assets (images, models, etc.)[name].[hash][extname]
        },
        manualChunks: undefined, // Disable manual chunk splitting if not necessary
        compact: true // Enable compact output to reduce file size
      },
    }, // Enable sourcemap in production (optional, useful for debugging)
    sourcemap: false, // Set to true if you want sourcemaps for debugging
    assetsDir: "assets" // Place all assets like images, fonts, WASM files in the assets folder,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      stream: 'stream-browserify',
      buffer: 'buffer',
      process: 'process/browser',
      events: 'events'
    }
  }
});