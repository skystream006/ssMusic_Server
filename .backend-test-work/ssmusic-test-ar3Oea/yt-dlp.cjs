#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const directory = __dirname;
const args = process.argv.slice(2);
const metadata = args.includes('--dump-single-json');
const phase = metadata ? 'metadata' : 'download';
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(args) + '\n');
fs.writeFileSync(path.join(directory, phase + '-started'), '');
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (Date.now() > deadline) process.exit(2);
  if (!fs.existsSync(path.join(directory, phase + '-release'))) return;
  clearInterval(timer);
  if (metadata) {
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json')));
    process.stdout.write(config.output);
    process.exitCode = config.exitCode || 0;
  } else {
    const output = args[args.indexOf('--output') + 1];
    fs.writeFileSync(path.join(path.dirname(output), 'Filename fallback.mp3'), '');
  }
}, 10);
