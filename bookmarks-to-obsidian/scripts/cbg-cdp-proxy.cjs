// Minimal TCP proxy: exposes host-loopback Chrome CDP (127.0.0.1:9222) on
// 0.0.0.0:9223 so the Docker container can reach it via host.docker.internal.
// Raw byte forwarding preserves the HTTP Host header (an IP literal from the
// container), which Chrome's remote-debugging host-allowlist accepts.
const net = require('net');
const LISTEN_PORT = 9223;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 9222;

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on('error', kill);
  upstream.on('error', kill);
});

server.on('error', (e) => { console.error('proxy error:', e.message); process.exit(1); });
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`CDP proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
