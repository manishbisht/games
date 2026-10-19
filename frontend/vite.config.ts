import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: {
    // That chunk is ~600 kB on its own, by design; the warning would only ever be about it.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Three.js is most of what four of the games download, and it changes
          // far less often than they do. In a chunk of its own its hash
          // survives a deploy that only touched a game, so returning players
          // keep it cached instead of fetching it again inside that game's chunk.
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
})
