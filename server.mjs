import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set(['index.html','styles.css','app.mjs','content.mjs','core.mjs','evidence.mjs','favicon.svg']);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!publicFiles.has(file) && file !== 'private/context.json') { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(path.join(root,file));
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT)||4173, '127.0.0.1', () => console.log('Путь маленьких шагов: http://127.0.0.1:' + server.address().port));
