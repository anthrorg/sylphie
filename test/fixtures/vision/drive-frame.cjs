// Drives real JPEG frames into the live backend's /ws/perception (end-to-end #0 smoke).
const WebSocket = require('ws');
const fs = require('fs');
const jpegPath = process.argv[2];
const url = process.argv[3] || 'ws://localhost:3010/ws/perception';
const jpeg = fs.readFileSync(jpegPath);
const ws = new WebSocket(url);
let sent = 0;
ws.on('open', async () => {
  console.log('WS_OPEN', url, 'jpeg bytes', jpeg.length);
  for (let i = 0; i < 10; i++) {
    ws.send(jpeg);
    sent++;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('SENT', sent, 'frames');
  setTimeout(() => { ws.close(); process.exit(0); }, 3000);
});
ws.on('message', (m) => {
  const s = Buffer.isBuffer(m) ? m.toString() : String(m);
  console.log('WS_MSG', s.slice(0, 160));
});
ws.on('error', (e) => { console.error('WS_ERR', e.message); process.exit(1); });
ws.on('close', (c, r) => console.log('WS_CLOSE', c, String(r).slice(0, 80)));
setTimeout(() => { console.log('TIMEOUT_EXIT'); process.exit(0); }, 15000);
