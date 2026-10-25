/* global __dirname, process */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Expand paths here so the same command works in PowerShell, cmd and Unix shells.
const files = fs.readdirSync(__dirname)
  .filter((name) => /^test-.*\.cjs$/.test(name))
  .sort()
  .map((name) => path.join(__dirname, name));
if (!files.length) throw new Error('No test files found.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
