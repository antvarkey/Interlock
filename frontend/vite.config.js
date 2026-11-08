import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the dashboard on :5173 and forwards /api to the FastAPI backend on :8000.
// `npm run build` writes frontend/dist, which the backend serves at http://localhost:8000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": process.env.INTERLOCK_API || "http://localhost:8000" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
