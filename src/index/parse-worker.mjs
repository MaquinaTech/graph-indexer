/** A parsing thread of the ParsePool: extracts one file per message (src/index/parsepool.mjs). */
import { parentPort } from 'node:worker_threads';
import { extractFile } from '../parse/extract.mjs';
import { specForPath } from '../parse/languages.mjs';

parentPort.on('message', async ({ id, rel, source }) => {
    try {
        parentPort.postMessage({ id, extraction: await extractFile(specForPath(rel), source, rel) });
    } catch (e) {
        parentPort.postMessage({ id, error: e.message });
    }
});
