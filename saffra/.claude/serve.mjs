// Minimal static server for local site review (no deps).
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
const root = '/Users/danielmuskin/Desktop/saffra-app';
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.png':'image/png', '.xml':'application/xml', '.txt':'text/plain', '.ico':'image/x-icon' };
createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const nf = await readFile(join(root, '404.html'));
      res.writeHead(404, { 'content-type': 'text/html' }); res.end(nf);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}).listen(4173, () => console.log('serving on 4173'));
