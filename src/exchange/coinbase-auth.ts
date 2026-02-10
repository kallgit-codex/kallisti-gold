// Coinbase CDP JWT Authentication (ECDSA ES256)
// Signs requests for Advanced Trade API
// Key format: organizations/{org_id}/apiKeys/{key_id} + PEM EC private key

import { SignJWT, importPKCS8 } from "jose";
import { randomBytes, createPrivateKey } from "crypto";

export interface CoinbaseAuthConfig {
  keyName: string;     // Full: "organizations/{org_id}/apiKeys/{key_id}"
  privateKey: string;  // PEM EC private key (may have literal \\n from env vars)
}

let cachedKey: CryptoKey | null = null;
let cachedKeyName: string = "";

function normalizePem(raw: string): string {
  // Env vars often store \n as literal two-char sequences — fix them
  let pem = raw.replace(/\\n/g, "\n");
  // Also handle cases where the PEM is all on one line
  if (!pem.includes("\n") && pem.includes("-----BEGIN")) {
    pem = pem.replace(/-----BEGIN (.+?)-----(.+?)-----END (.+?)-----/,
      (_, t1, body, t2) => `-----BEGIN ${t1}-----\n${body.match(/.{1,64}/g)?.join("\n")}\n-----END ${t2}-----`);
  }
  return pem;
}

async function getSigningKey(config: CoinbaseAuthConfig): Promise<CryptoKey> {
  if (cachedKey && cachedKeyName === config.keyName) return cachedKey;
  
  let pem = normalizePem(config.privateKey);
  
  // If it's an EC PRIVATE KEY (SEC1 format), convert to PKCS8 for jose
  if (pem.includes("BEGIN EC PRIVATE KEY")) {
    const nodeKey = createPrivateKey(pem);
    pem = nodeKey.export({ type: "pkcs8", format: "pem" }) as string;
  }
  
  cachedKey = await importPKCS8(pem, "ES256");
  cachedKeyName = config.keyName;
  return cachedKey;
}

/**
 * Generate a signed JWT for Coinbase Advanced Trade API
 */
export async function createJWT(
  config: CoinbaseAuthConfig,
  method: string,
  path: string
): Promise<string> {
  const key = await getSigningKey(config);
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  
  
  // Strip query params from URI - Coinbase only wants the path
  const pathOnly = path.split("?")[0];
  const cleanUri = `${method.toUpperCase()} api.coinbase.com${pathOnly}`;
  
  const jwt = await new SignJWT({
    sub: config.keyName,
    iss: "coinbase-cloud",
    uri: cleanUri,
  })
    .setProtectedHeader({
      alg: "ES256",
      kid: config.keyName,
      nonce,
      typ: "JWT",
    })
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(key);
  
  return jwt;
}

/**
 * Get Authorization header value for a request
 */
export async function getAuthHeader(
  config: CoinbaseAuthConfig,
  method: string,
  path: string
): Promise<string> {
  const jwt = await createJWT(config, method, path);
  return `Bearer ${jwt}`;
}
