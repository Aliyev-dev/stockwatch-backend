/* Copies non-TypeScript assets (the admin panel HTML) into dist/ after tsc. */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'admin', 'panel.html');
const destDir = path.join(__dirname, '..', 'dist', 'admin');
const dest = path.join(destDir, 'panel.html');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[build] copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`);
