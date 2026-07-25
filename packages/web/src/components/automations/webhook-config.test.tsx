// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { WebhookConfig } from "./webhook-config";

expect.extend(matchers);

afterEach(cleanup);

describe("WebhookConfig", () => {
  it("associates the webhook URL and API key labels with their fields", () => {
    render(
      <WebhookConfig webhookUrl="https://example.com/webhook" webhookApiKey="secret-api-key" />
    );

    expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://example.com/webhook");
    expect(screen.getByLabelText("API Key")).toHaveValue("secret-api-key");
  });
});
