const fs = require('fs');
const path = require('path');

const clientPath = process.env.EFS_CLIENT_PATH || path.resolve(__dirname, '../../client');
const sourceFile = path.resolve(__dirname, '../packages/nextjs/contracts/deployedContracts.ts');
const destFile = path.join(clientPath, 'src/libefs/generated/deployedContracts.ts');

if (!fs.existsSync(clientPath)) {
  console.log(`\n⏭️  Skipping ABI push: No client repo found at ${clientPath}.`);
  console.log(`   (If you have an external client, set EFS_CLIENT_PATH=/your/client/path)\n`);
  process.exit(0);
}

if (!fs.existsSync(sourceFile)) {
  console.log(`\n⏭️  Skipping ABI push: Source file not found at ${sourceFile}\n`);
  process.exit(0);
}

try {
  const genDir = path.dirname(destFile);
  if (!fs.existsSync(genDir)) {
    fs.mkdirSync(genDir, { recursive: true });
  }
  const sourceContent = fs.readFileSync(sourceFile, 'utf8');
  fs.writeFileSync(destFile, '// @ts-nocheck\n' + sourceContent);
  const stats = fs.statSync(sourceFile);
  console.log(`\n✅ Automatically pushed ABIs to EFS Client`);
  console.log(`   TO: ${destFile}`);
  console.log(`   (Source last modified: ${stats.mtime.toLocaleString()})\n`);
} catch (e) {
  console.log(`\n⚠️ Failed to push ABIs: ${e.message}\n`);
}
