import fs from 'node:fs/promises';
import os from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { detectTools } from './thumbs.js';

function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      const v4 = entry.family === 'IPv4' || entry.family === 4;
      if (!v4 || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      found.push(entry.address);
    }
  }
  return found.sort((a, b) => rank(a) - rank(b));
}

function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}

function toolLine(tools) {
  if (tools.sips && tools.ffmpeg) return 'macOS sips 做照片，ffmpeg 做视频封面';
  if (tools.sips) return 'macOS sips 做照片。没有 ffmpeg，视频可以播，但格子里暂时没有封面';
  if (tools.ffmpeg) return 'ffmpeg（这台不是 Mac，所以没有 sips）';
  return '没有找到 sips 或 ffmpeg。请在 Mac 上直接用系统自带的 sips';
}

function printBanner(config, tools) {
  const local = `http://127.0.0.1:${config.port}`;
  const lans = lanAddresses();
  console.log('');
  console.log(config.title);
  console.log(`照片目录   ${config.mediaDir}`);
  console.log(`缓存目录   ${config.cacheDir}`);
  console.log(`缩略图     ${toolLine(tools)}`);
  console.log(`查看码     ${config.accessCode ? '已打开' : '未设置，同一 Wi-Fi 里可以直接看'}`);
  console.log('');
  console.log('在这台电脑上打开');
  console.log(`  ${local}`);
  console.log('');
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    console.log('手机现在连不上：HOST 只监听了本机。请改成 0.0.0.0 后重启。');
  } else if (lans.length === 0) {
    console.log('没有发现局域网地址。请确认这台 Mac 已经连上家里的 Wi-Fi。');
  } else {
    console.log('手机连上同一个 Wi-Fi 后打开');
    for (const ip of lans) console.log(`  http://${ip}:${config.port}`);
  }
  console.log('');
  console.log('按 Ctrl+C 停止');
  console.log('');
}

const config = loadConfig();
const server = createApp(config);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。可以在 .env 里改 PORT。`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(config.port, config.host, async () => {
  process.title = 'family-media';
  try {
    await fs.access(config.mediaDir);
  } catch {
    console.warn(`注意：照片目录还不存在：${config.mediaDir}`);
  }
  const tools = await detectTools();
  printBanner(config, tools);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
