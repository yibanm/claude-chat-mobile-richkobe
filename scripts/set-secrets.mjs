#!/usr/bin/env node
// set-secrets.mjs —— 把主密钥签名凭据加密上传为 GitHub Actions secrets。
//
// 为什么需要这个脚本：GitHub 的 secrets API 要求用仓库公钥做 libsodium sealed box 加密，
// 手工操作要么得在网页端逐个粘贴（密钥 base64 有 5.9KB，网页粘贴易出错），要么得写一次性脚本。
// 写成文件是为了可复查、可重跑（换密钥时同一个脚本）。
//
// 安全纪律：
//   · 明文只在内存里，**绝不打印**（日志只输出 secret 名与 HTTP 状态码）；
//   · 读 keystore 与密码走文件路径，不把内容写进本脚本；
//   · token 从环境变量或 D:\1Tools\keys\github-token.txt 读，不硬编码；
//   · 上传目标是自己仓库的 Actions secrets（仅 CI 可读），不是公开位置。

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const OWNER = 'yibanm';
const REPO = 'claude-chat-mobile-richkobe';
const KEYSTORE = 'D:/1Tools/keys/richkobe-release.jks';
const PASSWORD_FILE = 'D:/1Tools/keys/richkobe-release.password.txt';
const ALIAS = 'richkobe';

// ── token：环境变量优先，回落到落盘文件（口径同 CLAUDE.md 0.10 与用户画像记录）──
function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const f = 'D:/1Tools/keys/github-token.txt';
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('找不到 GitHub token（GITHUB_TOKEN 环境变量与 D:/1Tools/keys/github-token.txt 均无）');
}

async function main() {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const token = readToken();
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const H = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  // 前置检查：文件必须都在，否则会把空值传上去（CI 侧表现为「签名失败」，排查很绕）
  if (!existsSync(KEYSTORE)) throw new Error(`keystore 不存在：${KEYSTORE}`);
  if (!existsSync(PASSWORD_FILE)) throw new Error(`密码文件不存在：${PASSWORD_FILE}`);
  const keystoreB64 = readFileSync(KEYSTORE).toString('base64');
  // storepass 与 keypass 同值（PKCS12 规范：不支持双密码，keytool 会静默忽略 -keypass）
  const password = readFileSync(PASSWORD_FILE, 'utf8').trim();
  if (!keystoreB64) throw new Error('keystore base64 为空');
  if (!password) throw new Error('密码文件为空');

  // 取仓库公钥（每次上传都重新取，公钥轮换后不会失效）
  const pkRes = await fetch(`${api}/actions/secrets/public-key`, { headers: H });
  if (!pkRes.ok) throw new Error(`取公钥失败 HTTP ${pkRes.status}: ${await pkRes.text()}`);
  const { key: publicKey, key_id: keyId } = await pkRes.json();

  const secrets = {
    CCM_KEYSTORE_BASE64: keystoreB64,
    CCM_KEYSTORE_PASSWORD: password,
    CCM_KEY_ALIAS: ALIAS,
    CCM_KEY_PASSWORD: password,
  };

  let failed = 0;
  for (const [name, plaintext] of Object.entries(secrets)) {
    const encrypted = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(plaintext), sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)),
      sodium.base64_variants.ORIGINAL,
    );
    const res = await fetch(`${api}/actions/secrets/${name}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
    });
    // PUT 成功返回 201（新建）或 204（更新）
    const ok = res.status === 201 || res.status === 204;
    if (!ok) failed += 1;
    // 只打印名字与状态码；明文与密文都不输出
    console.log(`${ok ? '✓' : '✘'} ${name} -> HTTP ${res.status}${ok ? '' : ` ${await res.text()}`}`);
  }

  if (failed) {
    console.error(`\n${failed} 个 secret 上传失败`);
    process.exit(1);
  }
  console.log(`\n✓ 4 个签名 secret 已就位（keystore ${(keystoreB64.length / 1024).toFixed(1)} KB base64，别名 ${ALIAS}）`);
}

main().catch(e => { console.error('✘', e.message); process.exit(1); });
