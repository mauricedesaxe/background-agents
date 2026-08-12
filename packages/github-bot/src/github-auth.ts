import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import { z } from "zod";

const collaboratorPermissionResponseSchema = z.object({
  permission: z.string(),
});

const installationTokenResponseSchema = z.object({
  token: z.string(),
});

const pullRequestResponseSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  /** User-Agent header sent on outbound GitHub API requests. */
  userAgent?: string;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parsePemPrivateKey(pem: string): Uint8Array {
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Unable to import private key. Ensure it is in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }
}

export async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getInstallationToken(
  jwt: string,
  installationId: string,
  userAgent: string
): Promise<string> {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Failed to get installation token: invalid response");
  }

  const parsed = installationTokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Failed to get installation token: invalid response");
  }
  return parsed.data.token;
}

export async function generateInstallationToken(config: GitHubAppConfig): Promise<string> {
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  return getInstallationToken(jwt, config.installationId, config.userAgent || DEFAULT_APP_NAME);
}

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface PermissionCheckResult {
  hasPermission: boolean;
  error?: boolean;
}

export async function checkSenderPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<PermissionCheckResult> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
      }
    );
    if (!response.ok) return { hasPermission: false, error: true };
    const parsed = collaboratorPermissionResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { hasPermission: false, error: true };
    const data = parsed.data;
    return { hasPermission: WRITE_PERMISSIONS.has(data.permission) };
  } catch {
    return { hasPermission: false, error: true };
  }
}

export async function postReaction(
  token: string,
  url: string,
  content: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function postIssueComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ body }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  userAgent: string = DEFAULT_APP_NAME
): Promise<{
  title: string;
  body: string | null;
  author: string;
  head: string;
  headSha: string;
  headRepository: string | null;
  base: string;
  baseRepository: string;
  isCrossRepository: boolean;
}> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch pull request: ${response.status}`);
  }
  const parsed = pullRequestResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Failed to fetch pull request: invalid response");
  const headRepository = parsed.data.head.repo?.full_name ?? null;
  const baseRepository = parsed.data.base.repo.full_name;
  return {
    title: parsed.data.title,
    body: parsed.data.body,
    author: parsed.data.user.login,
    head: parsed.data.head.ref,
    headSha: parsed.data.head.sha,
    headRepository,
    base: parsed.data.base.ref,
    baseRepository,
    isCrossRepository:
      headRepository === null || headRepository.toLowerCase() !== baseRepository.toLowerCase(),
  };
}
