import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], {
  cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const indexPath = 'dist/client/index.html';
const artifactValid = existsSync(indexPath)
  && existsSync('dist/client/audio-worklet.js')
  && readFileSync(indexPath, 'utf8').includes('Longland Timelapse');
const knownWindowsShutdown = process.platform === 'win32'
  && output.includes('Build complete')
  && output.includes('Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)');

if (result.status === 0) process.exit(0);
if (knownWindowsShutdown && artifactValid) {
  console.warn('Vinext completed the static export before a known Windows libuv shutdown assertion; verified output is present.');
  process.exit(0);
}
process.exit(result.status ?? 1);
