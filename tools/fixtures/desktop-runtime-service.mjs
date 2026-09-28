import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [mode, port, delay = '0', tag = 'desktop-test'] = process.argv.slice(2);
if (mode === 'launch') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', port, delay, tag], {
    // Explicitly model a daemon: on Windows a normal Node child is tied to its
    // parent's libuv job and disappears when that parent exits.
    windowsHide: true, stdio: 'ignore', detached: true,
  });
  child.once('spawn', () => {
    child.unref();
    process.stdout.write(`CHILD ${child.pid}\n`);
    setTimeout(() => process.exit(0), 150);
  });
  child.once('error', () => process.exit(9));
} else if (mode === 'fail') {
  setTimeout(() => {
    process.stderr.write('deliberate desktop test startup failure\n');
    process.exit(7);
  }, Number(delay));
} else if (delay === 'never') {
  setInterval(() => {}, 60_000);
} else {
  const server = net.createServer((socket) => socket.end());
  server.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(8);
  });
  setTimeout(() => server.listen(Number(port), '127.0.0.1', () => process.stdout.write(`READY ${process.pid}\n`)), Number(delay));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
