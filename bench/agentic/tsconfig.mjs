/**
 * The TypeScript program a grader or oracle builds over a checkout: the repository's root
 * tsconfig.json, or — for a monorepo whose packages each carry their own path aliases, which no
 * single root config expresses — the config named by GI_TSCONFIG (a JSON file resolved against the
 * checkout root; its `include` also sets the files, e.g. bench/agentic/tsconfig/twenty.json).
 */
import fs from 'node:fs';
import path from 'node:path';

export function tsSetup(ts, root) {
    const overlay = process.env.GI_TSCONFIG;
    if (overlay) {
        const cfg = ts.parseJsonConfigFileContent(JSON.parse(fs.readFileSync(overlay, 'utf8')), ts.sys, root);
        return { options: cfg.options, files: cfg.fileNames.map(f => path.resolve(f)) };
    }
    const cfgFile = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    const cfg = cfgFile ? ts.parseJsonConfigFileContent(ts.readConfigFile(cfgFile, ts.sys.readFile).config, ts.sys, root) : { options: {} };
    return { options: cfg.options, files: null };
}
