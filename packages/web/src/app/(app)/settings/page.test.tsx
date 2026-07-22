// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import SettingsPage from "./page";

expect.extend(matchers);

const { mockUseIsMobile, mockUseSidebarContext, mockUseSearchParams } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(),
  mockUseSidebarContext: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: mockUseIsMobile,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: mockUseSearchParams,
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
  CollapsedSidebarControls: () => <div data-testid="collapsed-sidebar-controls" />,
}));

vi.mock("@/components/settings/settings-nav", () => ({
  SettingsNav: () => <div data-testid="settings-nav" />,
}));

vi.mock("@/components/settings/appearance-settings", () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings" />,
}));

vi.mock("@/components/settings/secrets-settings", () => ({
  SecretsSettings: () => <div data-testid="secrets-settings" />,
}));

vi.mock("@/components/settings/environments-settings", () => ({
  EnvironmentsSettings: () => <div />,
}));

vi.mock("@/components/settings/models-settings", () => ({
  ModelsSettings: () => <div />,
}));

vi.mock("@/components/settings/data-controls-settings", () => ({
  DataControlsSettings: () => <div />,
}));

vi.mock("@/components/settings/keyboard-shortcuts-settings", () => ({
  KeyboardShortcutsSettings: () => <div />,
}));

vi.mock("@/components/settings/integrations-settings", () => ({
  IntegrationsSettings: () => <div />,
}));

vi.mock("@/components/settings/sandbox-settings", () => ({
  SandboxSettingsPage: () => <div />,
}));

vi.mock("@/components/settings/images-settings", () => ({
  ImagesSettings: () => <div />,
}));

vi.mock("@/components/settings/mcp-servers-settings", () => ({
  McpServersSettings: () => <div />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMobilePage(tab: string | null) {
  mockUseIsMobile.mockReturnValue(true);
  mockUseSidebarContext.mockReturnValue({ isOpen: false, toggle: vi.fn() });
  mockUseSearchParams.mockReturnValue({ get: () => tab } as never);
  return render(<SettingsPage />);
}

describe("SettingsPage on mobile", () => {
  it("keeps the sidebar actions reachable from the category list", () => {
    renderMobilePage(null);

    expect(screen.getByTestId("settings-nav")).toBeInTheDocument();
    expect(screen.getByTestId("collapsed-sidebar-controls")).toBeInTheDocument();
  });

  it("keeps the sidebar actions reachable from a category detail", () => {
    renderMobilePage("appearance");

    expect(screen.getByTestId("appearance-settings")).toBeInTheDocument();
    expect(screen.getByTestId("collapsed-sidebar-controls")).toBeInTheDocument();
  });
});
