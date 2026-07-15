---
name: whiteboard
description:
  Create and edit a live, interactive tldraw whiteboard in the Open-Inspect session UI by authoring
  tldraw records as JSON and posting them with the `board` command. The board is a real multiplayer
  canvas the user can pan/zoom/drag/edit while you edit it too — you go back and forth.
---

# whiteboard

Use this skill to put a **real interactive diagram** (architecture, data flow, sequence, ERD,
flowchart, wireframe) into the session UI. It is not a static image: the board is a live tldraw
canvas the user can pan, zoom, and edit, and **you edit the same board** by posting record changes.
When the user drags a box or you add one, both sides see it immediately.

No tldraw runs in the sandbox. You author tldraw **records as JSON** and post them with the `board`
bash command; the board document lives in the control plane. This replaces the old
export-a-`.tldr`-to-PNG flow — there is no `tldraw` CLI anymore.

For a screenshot you already have on disk, use `upload-screenshot` instead. This skill is for
diagrams you construct.

## The `board` command

`board` is a bash command on PATH. Three subcommands:

```bash
board create --title "System architecture"     # -> {"boardId":"...","title":"..."}
board mutate <boardId> --file changes.json      # apply record changes (also accepts stdin)
board snapshot <boardId>                        # print the document JSON (for saving to git)
```

`create` returns a `boardId` — keep it; every later edit needs it. The board appears in the
session's right sidebar under **Whiteboards** the moment you create it.

## Workflow

1. **Create the board**, capture the id:

   ```bash
   board create --title "Request flow"
   # {"boardId":"aX9...","title":"Request flow"}
   ```

2. **Author your shapes** into a `changes.json` with three arrays and post it:

   ```json
   {
     "create": [
       /* whole new records: shapes, then arrows, then bindings */
     ],
     "update": [
       /* partial patches to existing records: {"id","changes"} */
     ],
     "delete": [
       /* record ids to remove */
     ]
   }
   ```

   ```bash
   board mutate aX9... --file changes.json
   # {"applied":5,"created":5,"updated":0,"deleted":0}
   ```

   Validate the JSON first so a syntax error doesn't waste a round-trip:
   `python3 -m json.tool changes.json > /dev/null`.

3. **Editing later is the point.** To change a shape that already exists (including one the user
   just moved), send an `update` patch, not a fresh `create`. The server merges your patch onto the
   _current_ record, so you can recolor a box without stomping the position the user dragged it to:

   ```json
   { "update": [{ "id": "shape:box1", "changes": { "props": { "color": "red" } } }] }
   ```

   Read the live board first with `board snapshot <boardId>` when you need to see what the user
   changed before you edit.

## Authoring records

Records go in `create` as whole objects. Shapes and bindings are distinguished by `typeName`. Put
shapes on the default page: **`"parentId": "page:page"`**.

- **`id`** — `"shape:<unique>"` for shapes, `"binding:<unique>"` for bindings. Make each unique.
- **`index`** — a **fractional-index string** that orders shapes (higher = on top), never an
  integer. Use `"a1"`, `"a2"`, … `"a9"`, then `"aA"`..`"aZ"`, then `"aa"`..`"az"`. Each shape needs
  a unique index.
- **labels are `richText`**, not a plain string:
  `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Client"}]}]}`. An
  empty label is `{"type":"doc","content":[{"type":"paragraph","content":[]}]}`.
- **arrows bind to shapes via separate `binding` records** — the arrow's own `start`/`end` points
  stay `{"x":0,"y":0}` and tldraw routes the line from the bindings. One binding per bound end.

### Verified example — two boxes joined by a bound arrow

Every record below is validated against the server's schema. Start from it; copy a box and change
`id`, `x`, `index`, and the label to add more.

```json
{
  "create": [
    {
      "id": "shape:box1",
      "typeName": "shape",
      "type": "geo",
      "x": 100,
      "y": 100,
      "rotation": 0,
      "index": "a1",
      "parentId": "page:page",
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "props": {
        "geo": "rectangle",
        "w": 160,
        "h": 80,
        "dash": "draw",
        "url": "",
        "growY": 0,
        "scale": 1,
        "labelColor": "black",
        "color": "black",
        "fill": "none",
        "size": "m",
        "font": "draw",
        "align": "middle",
        "verticalAlign": "middle",
        "richText": {
          "type": "doc",
          "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Client" }] }]
        }
      }
    },
    {
      "id": "shape:box2",
      "typeName": "shape",
      "type": "geo",
      "x": 400,
      "y": 100,
      "rotation": 0,
      "index": "a2",
      "parentId": "page:page",
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "props": {
        "geo": "rectangle",
        "w": 160,
        "h": 80,
        "dash": "draw",
        "url": "",
        "growY": 0,
        "scale": 1,
        "labelColor": "black",
        "color": "black",
        "fill": "none",
        "size": "m",
        "font": "draw",
        "align": "middle",
        "verticalAlign": "middle",
        "richText": {
          "type": "doc",
          "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Server" }] }]
        }
      }
    },
    {
      "id": "shape:arrow1",
      "typeName": "shape",
      "type": "arrow",
      "x": 0,
      "y": 0,
      "rotation": 0,
      "index": "a3",
      "parentId": "page:page",
      "isLocked": false,
      "opacity": 1,
      "meta": {},
      "props": {
        "kind": "arc",
        "labelColor": "black",
        "color": "black",
        "fill": "none",
        "dash": "draw",
        "size": "m",
        "arrowheadStart": "none",
        "arrowheadEnd": "arrow",
        "font": "draw",
        "start": { "x": 0, "y": 0 },
        "end": { "x": 0, "y": 0 },
        "bend": 0,
        "richText": { "type": "doc", "content": [{ "type": "paragraph", "content": [] }] },
        "labelPosition": 0.5,
        "scale": 1,
        "elbowMidPoint": 0.5
      }
    },
    {
      "id": "binding:b1",
      "typeName": "binding",
      "type": "arrow",
      "fromId": "shape:arrow1",
      "toId": "shape:box1",
      "meta": {},
      "props": {
        "terminal": "start",
        "normalizedAnchor": { "x": 0.5, "y": 0.5 },
        "snap": "center",
        "isExact": false,
        "isPrecise": false
      }
    },
    {
      "id": "binding:b2",
      "typeName": "binding",
      "type": "arrow",
      "fromId": "shape:arrow1",
      "toId": "shape:box2",
      "meta": {},
      "props": {
        "terminal": "end",
        "normalizedAnchor": { "x": 0.5, "y": 0.5 },
        "snap": "center",
        "isExact": false,
        "isPrecise": false
      }
    }
  ],
  "update": [],
  "delete": []
}
```

Tips:

- More boxes: copy a geo record, change `id`, `x`/`y`, the `richText` label, and give it the next
  unique `index`.
- Give an arrow a label by putting text in its `richText`.
- Colors accept tldraw's named palette (`black`, `blue`, `green`, `red`, `orange`, `violet`, …);
  `fill` is `none`/`semi`/`solid`/`pattern`; `dash` is `draw`/`solid`/`dashed`/`dotted`.

## Save to GitHub (optional)

The board lives in the session UI. If you also want it in the repo (e.g. referenced from a PR), save
a `.tldr` snapshot and commit it:

```bash
board snapshot aX9... > docs/diagrams/request-flow.tldr
git add docs/diagrams/request-flow.tldr && git commit -m "docs: add request-flow board"
```

## Guardrails

- Don't claim the board exists unless `board create` returned a `boardId`.
- Don't claim an edit landed unless `board mutate` returned a JSON result with a non-error status. A
  `400 Mutation rejected by board schema` means a record has a bad prop — read the error, fix that
  record (check it against the verified example), and re-post. The whole batch is rejected on any
  invalid record, so nothing half-applies.
- `board snapshot` fails loudly if the board is unreachable — it never prints an empty document in
  that case, so a non-error snapshot genuinely reflects the board.
- `index` values are fractional-index strings (`a1`..`a9`, `aA`..`aZ`, `aa`..`az`), never integers,
  and each shape's index must be unique.
- To edit an existing shape, send an `update` patch — never re-`create` it from a stale snapshot, or
  you'll overwrite whatever the user changed in the meantime.
