/**
 * Local MongoDB for development without installing MongoDB:
 * runs the mongod binary that mongodb-memory-server downloads, with data kept
 * in ./.data/db so it survives restarts.   npm run db:local
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoBinary } from 'mongodb-memory-server';

const dbPath = resolve('.data/db');
mkdirSync(dbPath, { recursive: true });
const port = process.env.MONGO_PORT ?? '27017';
const bin = await MongoBinary.getPath();
console.log(`mongod ${bin}\n  data: ${dbPath}\n  url:  mongodb://127.0.0.1:${port}/interview-prep-kit`);
const child = spawn(bin, ['--dbpath', dbPath, '--port', port, '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
