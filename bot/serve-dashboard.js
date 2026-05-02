#!/usr/bin/env node
/**
 * Tiny zero-dependency static server for bot/dashboard.html.
 *
 * Auto-regenerates the dashboard every 30 seconds so the page is always fresh.
 *
 * Usage:
 *   node bot/serve-dashboard.js                  serves on http://localhost:8765
 *   PORT=4000 node bot/serve-dashboard.js        custom port
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, 'dashboard.html');
const PORT = Number(process.env.PORT ?? 8765);

function regenerate() {
  const r = spawnSync('node', ['bot/dashboard.js'], {
    cwd: join(__dirname, '..'),
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    console.error('Dashboard regenerate failed:', r.stderr?.toString());
  }
}

// Ensure dashboard exists on startup
if (!existsSync(DASHBOARD_PATH)) regenerate();

// Background regenerate every 30s so the page stays fresh
const interval = setInterval(() => {
  try { regenerate(); } catch (e) { console.error('regen error:', e.message); }
}, 30_000);

const server = createServer((req, res) => {
  // Auto-refresh on root request
  if (req.url === '/' || req.url === '/dashboard.html' || req.url === '/index.html') {
    try {
      regenerate();              // get freshest possible data
      const html = readFileSync(DASHBOARD_PATH, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard error: ${e.message}`);
    }
    return;
  }
  // Serve any other .html file in bot/ statically
  const requested = req.url.replace(/^\//, '');
  if (requested.endsWith('.html') && !requested.includes('..')) {
    const fp = join(__dirname, requested);
    try {
      const html = readFileSync(fp, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch { /* fall through to 404 */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✓ Dashboard server listening on http://localhost:${PORT}/`);
  console.log(`  (auto-regenerates every 30s)`);
});

process.on('SIGINT', () => {
  clearInterval(interval);
  server.close();
  process.exit(0);
});
