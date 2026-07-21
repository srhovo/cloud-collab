import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist', 'admin-production-console.html');
const template = 'checkSession({quiet:true});';
const rendered = 'checkSession({quiet:false});';
const source = fs.readFileSync(target, 'utf8');
const templateCount = source.split(template).length - 1;
const renderedCount = source.split(rendered).length - 1;

if (templateCount === 1 && renderedCount === 0) {
  const output = source.replace(template, rendered);
  fs.writeFileSync(target, output, 'utf8');
  process.stdout.write(`${JSON.stringify({ rendered: true, target: 'dist/admin-production-console.html' })}\n`);
} else if (templateCount === 0 && renderedCount === 1) {
  process.stdout.write(`${JSON.stringify({ rendered: false, alreadyRendered: true, target: 'dist/admin-production-console.html' })}\n`);
} else {
  const error = new Error('管理员控制台会话探测模板标记无效');
  error.code = 'ADMIN_CONSOLE_RENDER_MARKER_INVALID';
  error.details = { templateCount, renderedCount };
  throw error;
}
