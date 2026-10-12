import { registration } from './server/registration.mjs';
import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'bangumi-registration',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          void registration(req, res)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(next);
        });
      },
    },
  ],
  build: { target: 'es2022' },
  server: { port: 5173, strictPort: true },
});
