import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';

function iife(input, output) {
  return {
    input,
    output: { file: output, format: 'iife' },
    plugins: [
      resolve(),
      typescript({ tsconfig: './tsconfig.json' }),
    ],
  };
}

export default defineConfig([
  iife('src/injected/interceptor.ts', 'dist/interceptor.js'),
  iife('src/content/content-bridge.ts', 'dist/content-bridge.js'),
  iife('src/content/caption-observer.ts', 'dist/caption-observer.js'),
  iife('src/content/floating-popup.ts', 'dist/floating-popup.js'),
  {
    input: 'src/background/service-worker.ts',
    output: { file: 'dist/service-worker.js', format: 'es' },
    plugins: [
      resolve(),
      typescript({ tsconfig: './tsconfig.json' }),
    ],
  },
]);
