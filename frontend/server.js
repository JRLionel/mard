/*
 * 拼豆图纸转换器 · 前端静态服务（零依赖，Node >= 18）
 *
 * 作用：用 Node 托管本目录（frontend/），替代「双击 HTML 以 file:// 打开」的旧用法。
 * 仍是纯静态托管——不做任何构建、不注入内容；file:// 直接打开 index.html 也依然可用
 * （经典 <script> 无 CORS 问题），但 P1/P2 验收套件统一走本服务。
 *
 * 启动：
 *     cd frontend && npm start          # 等价于 node server.js
 *     PORT=3000 HOST=127.0.0.1 node server.js
 *
 * 端口约定：前端默认 8123，后端 8000（CUTOUT_URL，见 js/refine-cutout.js）。
 * 后端 app.py 的 CORS 为 allow_origins=["*"]，跨端口直连无需代理。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;                       // 只托管 frontend/ 自身
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8123;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// URL 解码失败（非法 % 序列）按 400 处理，不能让进程崩掉
function safeDecode(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  // 只取 pathname，丢弃查询串与 hash
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    res.writeHead(400).end("Bad Request");
    return;
  }
  const decoded = safeDecode(pathname);
  if (decoded === null) {
    res.writeHead(400).end("Bad Request");
    return;
  }

  // 浏览器（尤其 http 模式下）会自动请求 /favicon.ico；项目没有图标文件，
  // 回 204 空响应，避免每个页面都在控制台留一条 404 资源错误
  if (decoded === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 归一化并拒绝越出 frontend/ 的路径（防目录穿越）
  let filePath = path.normalize(path.join(ROOT, decoded));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  // 目录请求：命中 index.html（"/" 与 "/sub/" 都按目录入口处理）
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    /* 下面统一走 404 */
  }
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }
  }

  if (!stat || !stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found: " + pathname);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    // 开发服务：永远拿最新文件，避免改完代码浏览器还吃旧缓存
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`拼豆转换器前端已启动: http://${HOST}:${PORT}/`);
  console.log("按 Ctrl+C 停止。后端服务请另行启动: cd backend && python3 app.py（端口 8000）");
});
