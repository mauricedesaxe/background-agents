import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  ACTOR_HEADER,
  buildServiceAuthHeaders,
  generateInternalToken,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  type ServiceName,
} from "@open-inspect/shared";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

const SERVICE_SECRET: Record<ServiceName, string> = {
  web: "test-service-secret-web",
  "slack-bot": "test-service-secret-slack-bot",
  "github-bot": "test-service-secret-github-bot",
  "linear-bot": "test-service-secret-linear-bot",
  modal: "test-service-secret-modal",
};

async function signedFetch(p: {
  service: ServiceName;
  method: string;
  url: string;
  body?: string;
  actor?: string;
  mutateHeaders?: (headers: Record<string, string>) => void;
}): Promise<Response> {
  const headers = await buildServiceAuthHeaders({
    service: p.service,
    secret: SERVICE_SECRET[p.service],
    method: p.method,
    url: p.url,
    body: p.body,
    actor: p.actor,
  });
  p.mutateHeaders?.(headers);
  return SELF.fetch(p.url, {
    method: p.method,
    headers: { "Content-Type": "application/json", ...headers },
    body: p.body,
  });
}

describe("sig1 service-credential authentication", () => {
  beforeEach(cleanD1Tables);

  it("rejects services from user-only routes", async () => {
    for (const service of Object.keys(SERVICE_SECRET) as ServiceName[]) {
      const response = await signedFetch({
        service,
        method: "GET",
        url: "https://test.local/sessions",
      });
      expect(response.status, service).toBe(403);
    }
  });

  it("allows each service only on an explicit caller route", async () => {
    const cases: Array<{ service: ServiceName; method: string; url: string; status: number }> = [
      {
        service: "web",
        method: "POST",
        url: "https://test.local/auth/tokens/exchange",
        status: 400,
      },
      {
        service: "slack-bot",
        method: "GET",
        url: "https://test.local/model-preferences",
        status: 200,
      },
      {
        service: "github-bot",
        method: "GET",
        url: "https://test.local/environments/missing",
        status: 404,
      },
      {
        service: "linear-bot",
        method: "GET",
        url: "https://test.local/environments",
        status: 200,
      },
      {
        service: "modal",
        method: "GET",
        url: "https://test.local/image-builds/status",
        status: 200,
      },
    ];

    for (const testCase of cases) {
      const response = await signedFetch({
        service: testCase.service,
        method: testCase.method,
        url: testCase.url,
        body: testCase.method === "POST" ? "{}" : undefined,
      });
      expect(response.status, testCase.service).toBe(testCase.status);
    }
  });

  it("accepts a signed request with a query string regardless of param order", async () => {
    const signedUrl = "https://test.local/model-preferences?first=1&second=2";
    const headers = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: SERVICE_SECRET["slack-bot"],
      method: "GET",
      url: signedUrl,
    });
    const response = await SELF.fetch("https://test.local/model-preferences?second=2&first=1", {
      headers,
    });
    expect(response.status).toBe(200);
  });

  it("delivers the signed body intact to an explicitly granted handler", async () => {
    const response = await signedFetch({
      service: "modal",
      method: "POST",
      url: "https://test.local/image-builds/mark-stale",
      body: JSON.stringify({ max_age_seconds: 60 }),
    });
    expect(response.status).toBe(200);
  });

  it("does not let the web service credential mutate provider identities", async () => {
    const response = await signedFetch({
      service: "web",
      method: "PUT",
      url: "https://test.local/provider-identities/github/424242",
      body: JSON.stringify({ providerEmail: "victim@example.com" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects a body tampered after signing", async () => {
    const url = "https://test.local/provider-identities/github/424242";
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "PUT",
      url,
      body: JSON.stringify({ providerLogin: "octocat" }),
    });
    const response = await SELF.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ providerLogin: "evilcat" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a signature replayed against a different method or path", async () => {
    const url = "https://test.local/sessions";
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "GET",
      url,
    });
    const wrongPath = await SELF.fetch("https://test.local/repos", { headers });
    expect(wrongPath.status).toBe(401);

    const wrongMethod = await SELF.fetch(url, { method: "POST", headers });
    expect(wrongMethod.status).toBe(401);
  });

  it("rejects an identical signed request replay", async () => {
    const url = "https://test.local/model-preferences";
    const headers = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: SERVICE_SECRET["slack-bot"],
      method: "GET",
      url,
    });

    expect((await SELF.fetch(url, { headers })).status).toBe(200);
    expect((await SELF.fetch(url, { headers })).status).toBe(401);
  });

  it("allows exactly one of two concurrent identical signed requests", async () => {
    const url = "https://test.local/model-preferences";
    const headers = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: SERVICE_SECRET["slack-bot"],
      method: "GET",
      url,
    });
    const responses = await Promise.all([
      SELF.fetch(url, { headers }),
      SELF.fetch(url, { headers }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it("rejects a query string added after signing", async () => {
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET.web,
      method: "GET",
      url: "https://test.local/sessions",
    });
    const response = await SELF.fetch("https://test.local/sessions?createdBy=someone-else", {
      headers,
    });
    expect(response.status).toBe(401);
  });

  it("rejects an actor header rewritten after signing", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "slack:U0001",
      mutateHeaders: (headers) => {
        headers[ACTOR_HEADER] = "slack:U0002";
      },
    });
    expect(response.status).toBe(401);
  });

  it("denies actors outside the service's namespace", async () => {
    const response = await signedFetch({
      service: "slack-bot",
      method: "GET",
      url: "https://test.local/sessions",
      actor: "github:1",
    });
    expect(response.status).toBe(401);
  });

  it("denies actor assertions from web and modal", async () => {
    for (const service of ["web", "modal"] as const) {
      const response = await signedFetch({
        service,
        method: "GET",
        url: "https://test.local/sessions",
        actor: service === "web" ? "slack:U1" : "github:1",
      });
      expect(response.status, service).toBe(401);
    }
  });

  it("persists bot session ownership from the signed actor", async () => {
    const created = await signedFetch({
      service: "slack-bot",
      method: "POST",
      url: "https://test.local/sessions",
      actor: "slack:U0001",
      body: JSON.stringify({
        title: "Slack-owned session",
        model: "anthropic/claude-haiku-4-5",
      }),
    });
    expect(created.status).toBe(201);

    const identity = await new UserStore(env.DB).getIdentity("slack", "U0001");
    expect(identity).not.toBeNull();
    const stored = await env.DB.prepare(
      "SELECT title, user_id, spawn_source FROM sessions WHERE title = ?"
    )
      .bind("Slack-owned session")
      .first<{ title: string; user_id: string; spawn_source: string }>();
    expect(stored).toEqual({
      title: "Slack-owned session",
      user_id: identity!.userId,
      spawn_source: "slack-bot",
    });
  });

  it("requires a user or signed actor before any service can create a session", async () => {
    for (const service of Object.keys(SERVICE_SECRET) as ServiceName[]) {
      const response = await signedFetch({
        service,
        method: "POST",
        url: "https://test.local/sessions",
        body: JSON.stringify({
          title: "Actorless session",
          model: "anthropic/claude-haiku-4-5",
        }),
      });
      expect(response.status, service).toBe(403);
    }

    const sessionCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{
      n: number;
    }>();
    expect(sessionCount?.n).toBe(0);
  });

  it("rejects an unknown service name", async () => {
    const response = await signedFetch({
      service: "modal",
      method: "GET",
      url: "https://test.local/sessions",
      mutateHeaders: (headers) => {
        headers[SERVICE_HEADER] = "not-a-service";
      },
    });
    expect(response.status).toBe(401);
  });

  it("a failed service signature is terminal even with a bearer alongside", async () => {
    const response = await signedFetch({
      service: "web",
      method: "GET",
      url: "https://test.local/sessions",
      mutateHeaders: (headers) => {
        headers[SERVICE_SIGNATURE_HEADER] = headers[SERVICE_SIGNATURE_HEADER].replace(/.$/, (c) =>
          c === "0" ? "1" : "0"
        );
        headers["Authorization"] = "Bearer some-other-credential";
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects the retired shared bearer", async () => {
    const token = await generateInternalToken("test-hmac-secret-for-integration-tests");
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});
