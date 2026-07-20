import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SECRET_NAMES = Object.freeze([
  'CLOUD_ADMIN_PASSWORD',
  'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
  'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_SESSION_SECRET',
  'CLOUD_ADMIN_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_DEVICE_REF_SALT',
  'CLOUD_ADMIN_ROLLBACK_REF_SALT',
  'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
]);

function usage() {
  return '用法：node scripts/generate-production-secrets-v1.mjs --output /安全路径/cloud-collab-production-secrets.env';
}

function parseOutput(argv) {
  const index = argv.indexOf('--output');
  if (index < 0 || !argv[index + 1]) throw new Error(usage());
  if (argv.includes('--stdout')) throw new Error('为避免泄露，生产密钥生成器不支持输出到stdout');
  return path.resolve(argv[index + 1]);
}

function secureRandom(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function main() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    throw new Error('禁止在CI或GitHub Actions中生成生产密钥，避免进入日志或Artifact');
  }

  const output = parseOutput(process.argv.slice(2));
  if (fs.existsSync(output)) throw new Error(`目标文件已存在，拒绝覆盖：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });

  const values = new Map();
  for (const name of SECRET_NAMES) {
    const bytes = name === 'CLOUD_ADMIN_PASSWORD' ? 32 : 48;
    values.set(name, secureRandom(bytes));
  }

  const unique = new Set(values.values());
  if (unique.size !== values.size) throw new Error('随机密钥发生重复，已拒绝写出');
  for (const [name, value] of values) {
    if (Buffer.byteLength(value, 'utf8') < 32) throw new Error(`${name}长度不足`);
  }

  const content = [
    '# 仅存于本机安全位置和EdgeOne私密环境变量；不得提交、截图或发送到聊天。',
    'CLOUD_ADMIN_USERNAME=xiaxue',
    ...[...values].map(([name, value]) => `${name}=${value}`),
    '',
  ].join('\n');

  const descriptor = fs.openSync(output, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  console.log(`已生成${values.size}项相互独立的生产密钥：${output}`);
  console.log('文件权限已请求设置为0600；请录入EdgeOne后安全删除本地文件。');
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
