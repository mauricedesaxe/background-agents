import { page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { createShapeId, createTLStore, defaultShapeUtils, type Editor, toRichText } from "tldraw";
import { expect, test, vi } from "vitest";
import type * as BoardCanvasModule from "./board-canvas";

let inspectionStore: ReturnType<typeof createTLStore>;

vi.mock("./board-canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof BoardCanvasModule>();
  return {
    ...actual,
    useBoardSync: () => ({ status: "synced-remote", store: inspectionStore }),
  };
});

import { BoardCanvas } from "./board-canvas";
import BoardInspection from "./board-inspection";

test("declares the rendered long-text and layered inspection fixture ready", async () => {
  const authoringContainer = document.createElement("div");
  authoringContainer.style.width = "1440px";
  authoringContainer.style.height = "900px";
  document.body.append(authoringContainer);
  const authoringRoot = createRoot(authoringContainer);

  let resolveEditor!: (editor: Editor) => void;
  const mounted = new Promise<Editor>((resolve) => {
    resolveEditor = resolve;
  });
  inspectionStore = createTLStore({ shapeUtils: defaultShapeUtils });
  authoringRoot.render(<BoardCanvas store={inspectionStore} readonly onMount={resolveEditor} />);

  const editor = await mounted;
  editor.createShapes([
    {
      id: createShapeId("long-text"),
      type: "geo",
      x: 0,
      y: 0,
      props: {
        w: 360,
        h: 180,
        richText: toRichText(
          "A deliberately long inspection label wraps inside this shape without clipping"
        ),
      },
    },
    {
      id: createShapeId("bottom"),
      type: "geo",
      x: 420,
      y: 80,
      props: { w: 320, h: 220, color: "blue", richText: toRichText("Bottom layer") },
    },
    {
      id: createShapeId("top"),
      type: "geo",
      x: 520,
      y: 140,
      props: { w: 220, h: 140, color: "red", richText: toRichText("Top layer") },
    },
  ]);
  await editor.fonts.loadRequiredFontsForCurrentPage();
  authoringContainer.style.display = "none";

  window.location.hash = "#token=browser-test-token";
  const inspectionContainer = document.createElement("div");
  inspectionContainer.style.width = "1440px";
  inspectionContainer.style.height = "900px";
  document.body.append(inspectionContainer);
  createRoot(inspectionContainer).render(
    <BoardInspection sessionId="session-browser-test" boardId="board-browser-test" />
  );

  await expect
    .poll(() => inspectionContainer.querySelector('[data-board-inspection-state="ready"]'))
    .not.toBeNull();

  await expect
    .poll(() => inspectionContainer.querySelector('[data-shape-id="shape:bottom"]'))
    .not.toBeNull();
  await expect
    .poll(() => inspectionContainer.querySelector('[data-shape-id="shape:top"]'))
    .not.toBeNull();
  await expect
    .poll(() => {
      const bottom = inspectionContainer
        .querySelector<HTMLElement>('[data-shape-id="shape:bottom"]')
        ?.getBoundingClientRect();
      const top = inspectionContainer
        .querySelector<HTMLElement>('[data-shape-id="shape:top"]')
        ?.getBoundingClientRect();
      return Math.min(bottom?.width ?? 0, bottom?.height ?? 0, top?.width ?? 0, top?.height ?? 0);
    })
    .toBeGreaterThan(0);

  const longTextShape = inspectionContainer.querySelector<HTMLElement>(
    '[data-shape-id="shape:long-text"]'
  )!;
  const bottomShape = inspectionContainer.querySelector<HTMLElement>(
    '[data-shape-id="shape:bottom"]'
  )!;
  const topShape = inspectionContainer.querySelector<HTMLElement>('[data-shape-id="shape:top"]')!;
  const textElement = [...longTextShape.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      element.textContent ===
      "A deliberately long inspection label wraps inside this shape without clipping"
  )!;
  await expect.element(page.elementLocator(textElement)).toBeVisible();
  const textRange = document.createRange();
  textRange.selectNodeContents(textElement);
  const textLines = [...textRange.getClientRects()].filter((rect) => rect.width > 0);
  const longTextBox = longTextShape.getBoundingClientRect();
  const bottomBox = bottomShape.getBoundingClientRect();
  const topBox = topShape.getBoundingClientRect();
  expect(textLines.length).toBeGreaterThan(1);
  expect(Math.min(...textLines.map((rect) => rect.left))).toBeGreaterThanOrEqual(longTextBox.left);
  expect(Math.max(...textLines.map((rect) => rect.right))).toBeLessThanOrEqual(longTextBox.right);
  expect(Math.min(...textLines.map((rect) => rect.top))).toBeGreaterThanOrEqual(longTextBox.top);
  expect(Math.max(...textLines.map((rect) => rect.bottom))).toBeLessThanOrEqual(longTextBox.bottom);
  expect(topBox.x).toBeLessThan(bottomBox.x + bottomBox.width);
  expect(topBox.y).toBeLessThan(bottomBox.y + bottomBox.height);
  expect(topBox.x + topBox.width).toBeLessThanOrEqual(1440);
  expect(topBox.y + topBox.height).toBeLessThanOrEqual(900);

  expect(bottomShape.compareDocumentPosition(topShape) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
    0
  );
});
