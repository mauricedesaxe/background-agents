---
name: export-diagram
description: Hand-author a tldraw .tldr file and export it to a diagram (SVG for the web UI, PNG for PRs), then surface it in the Open-Inspect web UI or embed it in a PR
---

# export-diagram

Use this skill to produce a real rendered diagram (architecture, data flow, sequence, ERD,
flowchart, wireframe). You hand-author a `.tldr` JSON file, export it with the `tldraw` CLI
(bundled in the image), and then either upload it to the session web UI or commit it into a PR so
GitHub renders it inline.

Prefer **SVG for the web UI** (`upload-media` now accepts it) — SVG renders crisply at any size and
sidesteps the PNG rasterizer's timeout on large canvases entirely. Use **PNG for PR embeds**, since
GitHub renders committed PNGs inline reliably.

This is for genuine diagrams. For a screenshot you already have on disk, use `upload-screenshot`.

## Key Facts

- `tldraw` (alias `tldraw-cli`) is a **bash command** on PATH, installed globally in the image. Run
  it with your Bash tool. It renders `.tldr` files with a headless browser (puppeteer's
  `chrome-headless-shell`, pre-warmed at build time).
- The image runs as **root**. tldraw-cli v6 already launches its browser with `--no-sandbox` and
  `--disable-setuid-sandbox` baked in, so **no extra flags or env vars are needed** — the plain
  `tldraw export ...` command works as root out of the box.
- `upload-media` accepts `.svg`, `.png`, `.jpg`, and `.webp` for the web UI. SVG is preferred for
  the web UI (renders at any size, no rasterizer timeout); PNG still works if you need a raster.

## When To Use It

- The user asks for a diagram, chart, architecture sketch, flow, or wireframe.
- You're explaining a system with 3+ components or a data flow and a picture would help.
- You want to embed a diagram in a PR description.

## The `.tldr` file format

A `.tldr` file is JSON with three top-level keys: `tldrawFileFormatVersion` (always `1`), a
`schema` block, and a `records` array.

**Records you need:**

1. One `document:document` record (`typeName: "document"`).
2. One `page:page1` record (`typeName: "page"`).
3. Shape records (`typeName: "shape"`), each with `parentId: "page:page1"`.
4. Optional `binding` records that connect an arrow's ends to shapes.

### CRITICAL: `index` fields are fractional-index keys, not integers

Every shape has an `index` string that orders it. These are **fractional indices**, NOT integers.
Use this exact sequence and never anything else:

```
"a1", "a2", "a3", ... "a9",   then
"aA", "aB", ... "aZ",         then
"aa", "ab", ... "az"
```

Never write `"a10"`, `"b1"`, `"1"`, or a bare integer. Each shape needs a **unique** index. The
page itself also uses an index (`"a1"` is fine; shapes on the page get their own `"a1".."a9"`).

### CRITICAL: arrows bind via separate `binding` records

Arrows do NOT embed their connections inside `props.start` / `props.end`. Instead:

- The arrow shape's `props.start` and `props.end` stay as plain points (`{"x":0,"y":0}`) — tldraw
  overrides them from the bindings at render time.
- You add one `binding` record per bound end: `typeName: "binding"`, `type: "arrow"`,
  `fromId: "<arrow shape id>"`, `toId: "<target shape id>"`, and
  `props.terminal: "start"` or `"end"`, with a `normalizedAnchor` (use `{"x":0.5,"y":0.5}` to
  anchor at the target's center — tldraw routes the line to the nearest edge).

### Schema block

Copy this schema block verbatim. It matches the tldraw version bundled in the image, so no store
migration runs. If you declare older sequence numbers you can trigger a migration that fails.

```json
{
  "schemaVersion": 2,
  "sequences": {
    "com.tldraw.store": 4,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 25,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 5,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.asset.bookmark": 1,
    "com.tldraw.asset.image": 3,
    "com.tldraw.asset.video": 3,
    "com.tldraw.shape.arrow": 4,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 1,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.frame": 0,
    "com.tldraw.shape.geo": 8,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.highlight": 0,
    "com.tldraw.shape.image": 3,
    "com.tldraw.shape.line": 4,
    "com.tldraw.shape.note": 6,
    "com.tldraw.shape.text": 2,
    "com.tldraw.shape.video": 2,
    "com.tldraw.binding.arrow": 0
  }
}
```

## Complete working example

This exact file exports cleanly to a two-box "Client → Server" diagram (two geo rectangles joined
by a bound arrow). Start from it and add/replace shapes. Note `text` on geo shapes is the label,
geo `"rectangle"` is the box, and only document + page + shapes + bindings are needed (no camera /
instance records required for export).

```json
{
  "tldrawFileFormatVersion": 1,
  "schema": {
    "schemaVersion": 2,
    "sequences": {
      "com.tldraw.store": 4,
      "com.tldraw.asset": 1,
      "com.tldraw.camera": 1,
      "com.tldraw.document": 2,
      "com.tldraw.instance": 25,
      "com.tldraw.instance_page_state": 5,
      "com.tldraw.page": 1,
      "com.tldraw.instance_presence": 5,
      "com.tldraw.pointer": 1,
      "com.tldraw.shape": 4,
      "com.tldraw.asset.bookmark": 1,
      "com.tldraw.asset.image": 3,
      "com.tldraw.asset.video": 3,
      "com.tldraw.shape.arrow": 4,
      "com.tldraw.shape.bookmark": 2,
      "com.tldraw.shape.draw": 1,
      "com.tldraw.shape.embed": 4,
      "com.tldraw.shape.frame": 0,
      "com.tldraw.shape.geo": 8,
      "com.tldraw.shape.group": 0,
      "com.tldraw.shape.highlight": 0,
      "com.tldraw.shape.image": 3,
      "com.tldraw.shape.line": 4,
      "com.tldraw.shape.note": 6,
      "com.tldraw.shape.text": 2,
      "com.tldraw.shape.video": 2,
      "com.tldraw.binding.arrow": 0
    }
  },
  "records": [
    {
      "gridSize": 10,
      "name": "",
      "meta": {},
      "id": "document:document",
      "typeName": "document"
    },
    {
      "meta": {},
      "id": "page:page1",
      "name": "Page 1",
      "index": "a1",
      "typeName": "page"
    },
    {
      "x": 100,
      "y": 100,
      "rotation": 0,
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "type": "geo",
      "parentId": "page:page1",
      "index": "a1",
      "id": "shape:box1",
      "typeName": "shape",
      "props": {
        "w": 160,
        "h": 80,
        "geo": "rectangle",
        "color": "black",
        "labelColor": "black",
        "fill": "none",
        "dash": "draw",
        "size": "m",
        "font": "draw",
        "text": "Client",
        "align": "middle",
        "verticalAlign": "middle",
        "growY": 0,
        "url": ""
      }
    },
    {
      "x": 400,
      "y": 100,
      "rotation": 0,
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "type": "geo",
      "parentId": "page:page1",
      "index": "a2",
      "id": "shape:box2",
      "typeName": "shape",
      "props": {
        "w": 160,
        "h": 80,
        "geo": "rectangle",
        "color": "black",
        "labelColor": "black",
        "fill": "none",
        "dash": "draw",
        "size": "m",
        "font": "draw",
        "text": "Server",
        "align": "middle",
        "verticalAlign": "middle",
        "growY": 0,
        "url": ""
      }
    },
    {
      "x": 0,
      "y": 0,
      "rotation": 0,
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "type": "arrow",
      "parentId": "page:page1",
      "index": "a3",
      "id": "shape:arrow1",
      "typeName": "shape",
      "props": {
        "dash": "draw",
        "size": "m",
        "fill": "none",
        "color": "black",
        "labelColor": "black",
        "bend": 0,
        "start": { "x": 0, "y": 0 },
        "end": { "x": 0, "y": 0 },
        "arrowheadStart": "none",
        "arrowheadEnd": "arrow",
        "text": "",
        "font": "draw",
        "labelPosition": 0.5
      }
    },
    {
      "typeName": "binding",
      "id": "binding:bind1",
      "type": "arrow",
      "fromId": "shape:arrow1",
      "toId": "shape:box1",
      "meta": {},
      "props": {
        "terminal": "start",
        "normalizedAnchor": { "x": 0.5, "y": 0.5 },
        "isExact": false,
        "isPrecise": false
      }
    },
    {
      "typeName": "binding",
      "id": "binding:bind2",
      "type": "arrow",
      "fromId": "shape:arrow1",
      "toId": "shape:box2",
      "meta": {},
      "props": {
        "terminal": "end",
        "normalizedAnchor": { "x": 0.5, "y": 0.5 },
        "isExact": false,
        "isPrecise": false
      }
    }
  ]
}
```

Tips for bigger diagrams:

- More boxes: copy a geo record, change `id`, `x`, `y`, `text`, and give it the next unique
  `index` (`a4`, `a5`, ...).
- Text-only labels: use a `text` shape (`"type": "text"`).
- Give arrows a label by setting `props.text`.

## Required Workflow

1. **Write** the `.tldr` file to disk (e.g. `diagram.tldr`).

2. **Validate the JSON first** — a syntax error wastes a browser launch:

   ```bash
   python3 -m json.tool diagram.tldr > /dev/null
   ```

3. **Export, wrapped in `timeout` so it can never hang the session.** `-o` is a **directory**, not
   a filename; the output is named after the input (`diagram.tldr` → `diagram.svg` / `diagram.png`).
   No `--no-sandbox` flag is needed (tldraw-cli passes it).

   **For the web UI, export SVG** — it renders at any size and never hits the rasterizer timeout:

   ```bash
   timeout 120 tldraw export diagram.tldr -f svg -o ./   # -> diagram.svg
   ```

   **For a PR embed, export PNG** (GitHub renders committed PNGs inline). Keep `--scale` at the
   default (omit it) — a high scale on a large canvas can make the headless PNG renderer time out:

   ```bash
   timeout 120 tldraw export diagram.tldr -f png -o ./   # -> diagram.png
   ```

   If the PNG export exits non-zero (`124` = timed out) or leaves a 0-byte `diagram.png`, the canvas
   is too large/complex for the PNG rasterizer. For a PR you can use the SVG path instead (step 5b
   works with `.svg`). Otherwise **simplify the diagram** (fewer, closer-together shapes) and
   re-export.

4. **Confirm the output exists and is non-empty** before claiming success (the SVG or PNG you
   exported):

   ```bash
   ls -l diagram.svg diagram.png 2>/dev/null
   ```

5. **Surface it** one of two ways (below).

### (a) Web UI

Prefer the SVG you exported — it renders as a media card exactly like a raster screenshot:

```bash
upload-media diagram.svg --caption "Client to server request flow"
```

Report the returned `artifactId`. `upload-media` accepts `.svg`, `.png`, `.jpg`, and `.webp`; SVG is
preferred for the web UI. If you only have a PNG, `upload-media diagram.png ...` works the same way.

### (b) PR embed

Commit the PNG into the repo (a `docs/diagrams/` folder keeps it tidy) and reference it in the PR
body with a relative Markdown image path so GitHub renders it inline:

```bash
mkdir -p docs/diagrams
cp diagram.png docs/diagrams/diagram.png
git add docs/diagrams/diagram.png
git commit -m "docs: add request-flow diagram"
```

Then in the PR description:

```markdown
![Client to server request flow](docs/diagrams/diagram.png)
```

## Success Criteria

The task is not complete until either:

- **Web UI:** `upload-media` returned JSON containing an `artifactId`, and you reported it (SVG
  preferred, PNG accepted); or
- **PR:** `docs/diagrams/diagram.png` exists, is committed, and the PR body references it with a
  relative `![...](docs/diagrams/diagram.png)` path.

## Guardrails

- Do not claim the diagram was created unless the exported file (`diagram.svg` or `diagram.png`)
  actually exists on disk (`ls -l` it).
- Do not claim it was uploaded unless `upload-media` returned an `artifactId`.
- If `tldraw export` fails (e.g. `migrationFailed`, or a JSON/index error), report the actual error
  and fix the file — do not retry silently. A `migrationFailed` / `split` error almost always means
  the `schema` block or a shape record has wrong sequence numbers or malformed props; re-check them
  against the working example above.
- Remember `index` values are fractional-index strings (`a1`..`a9`, `aA`..`aZ`, `aa`..`az`), never
  integers, and each shape's index must be unique.
