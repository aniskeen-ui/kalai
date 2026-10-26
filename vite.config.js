import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        artist: fileURLToPath(new URL('./artist.html', import.meta.url)),
        seller: fileURLToPath(new URL('./seller.html', import.meta.url)),
        offers: fileURLToPath(new URL('./offers.html', import.meta.url)),
        supplier: fileURLToPath(new URL('./supplier.html', import.meta.url)),
        little: fileURLToPath(new URL('./little.html', import.meta.url)),
      },
    },
  },
});
