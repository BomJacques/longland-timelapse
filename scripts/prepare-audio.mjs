import { mkdirSync, copyFileSync } from 'node:fs';
const source = new URL('../node_modules/@ozymandiasthegreat/vad/', import.meta.url);
const target = new URL('../public/vendor/vad/', import.meta.url);
mkdirSync(target, { recursive: true });
copyFileSync(new URL('dist/libfvad.wasm', source), new URL('libfvad.wasm', target));
for (const name of ['LICENSE', 'AUTHORS', 'PATENTS']) copyFileSync(new URL(name, source), new URL(name + '.txt', target));
const debug = new URL('../public/debug/', import.meta.url);
mkdirSync(debug, { recursive: true });
copyFileSync(new URL('../tests/fixtures/speech16.wav', import.meta.url), new URL('speech16.wav', debug));
