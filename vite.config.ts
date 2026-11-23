import { defineConfig } from 'vite';

// Entry is game.html. The old single-file index.html is left untouched.
// No node:path / __dirname usage, so @types/node is not required.
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: '/game.html',
    // 自动化测试会在仓库根目录创建临时 Chrome profile（.chrome-*），
    // Vite 的 fs watcher 一旦扫到其中被 Chrome 锁定的 Cookies 文件就会 EBUSY 崩溃。
    // 这里明确排除测试产物目录，保证 dev server 长时间稳定。
    watch: {
      ignored: [
        '**/.chrome-*/**',
        '**/devtest/**',
        // 文本编辑器/Agent 的原子写入会在源码目录留下临时目录，删除瞬间会 EBUSY
        '**/.*.tmpdir/**',
        '**/*.tmp'
      ]
    }
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: 'game.html'
      }
    }
  }
});
