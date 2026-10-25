const fs = require('node:fs');
const path = require('node:path');

const mapPath = process.argv[2] ?? path.join(
  __dirname, '..', 'android', 'app', 'build', 'generated', 'sourcemaps',
  'react', 'release', 'index.android.bundle.map',
);
const sourceMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const singletonPackages = ['react', 'react-native', 'expo', 'react-native-safe-area-context'];
let failed = false;

for (const packageName of singletonPackages) {
  const marker = `/node_modules/${packageName}/`;
  const roots = new Set();
  for (const source of sourceMap.sources) {
    const normalized = source.replaceAll('\\', '/');
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) roots.add(normalized.slice(0, index + marker.length - 1));
  }
  if (roots.size !== 1) {
    console.error(`${packageName}: expected one bundled copy, found ${roots.size}`);
    for (const root of roots) console.error(`  ${root}`);
    failed = true;
  } else {
    console.log(`${packageName}: one bundled copy`);
  }
}

if (failed) process.exitCode = 1;
