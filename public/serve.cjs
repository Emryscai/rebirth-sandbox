/**
 * 极简本地静态服务器：双击“开始游戏.bat”时使用。
 * 解决浏览器直接双击 game.html 时的 file:// 模块/CORS 限制。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8787;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json'
};

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/game.html';

    const file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`游戏地址: http://127.0.0.1:${port}/game.html`);
    console.log('关闭此窗口即可停止本地服务器。');
  });
