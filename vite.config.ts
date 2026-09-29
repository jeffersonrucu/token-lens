import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Unusual ports on purpose: the machine's Docker projects hold the common ones.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 47832,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:47831',
    },
  },
})
