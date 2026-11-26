import { build } from 'esbuild';
await build({
    entryPoints: {
        server: 'server/index.ts',
        migrate: 'scripts/migrate.ts',
        'create-account': 'scripts/create-account.ts',
        cleanup: 'scripts/cleanup.ts',
    },
    outdir: 'dist',
    outExtension: {'.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: true,
});