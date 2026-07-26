"use client";

import "tldraw/tldraw.css";
import { useSync } from "@tldraw/sync";
import {
  CollaboratorBrushOverlayUtil,
  CollaboratorCursorOverlayUtil,
  CollaboratorHintOverlayUtil,
  CollaboratorScribbleOverlayUtil,
  CollaboratorShapeIndicatorOverlayUtil,
  Tldraw,
  type Editor,
  type TLAssetStore,
  type TLComponents,
  type TLStore,
  type TLStoreWithStatus,
} from "tldraw";
import { useEffect, useMemo } from "react";

const boardAssets: TLAssetStore = {
  upload() {
    return Promise.reject(new Error("Image assets are not supported on boards"));
  },
  resolve: () => null,
};

const LICENSE_KEY = process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY;

class HiddenCollaboratorBrushOverlay extends CollaboratorBrushOverlayUtil {
  override isActive() {
    return false;
  }
}

class HiddenCollaboratorCursorOverlay extends CollaboratorCursorOverlayUtil {
  override isActive() {
    return false;
  }
}

class HiddenCollaboratorHintOverlay extends CollaboratorHintOverlayUtil {
  override isActive() {
    return false;
  }
}

class HiddenCollaboratorScribbleOverlay extends CollaboratorScribbleOverlayUtil {
  override isActive() {
    return false;
  }
}

class HiddenCollaboratorShapeIndicatorOverlay extends CollaboratorShapeIndicatorOverlayUtil {
  override isActive() {
    return false;
  }
}

const HIDDEN_COLLABORATOR_OVERLAYS = [
  HiddenCollaboratorBrushOverlay,
  HiddenCollaboratorCursorOverlay,
  HiddenCollaboratorHintOverlay,
  HiddenCollaboratorScribbleOverlay,
  HiddenCollaboratorShapeIndicatorOverlay,
];

export function useBoardSync(uri: () => Promise<string>, readonly = false) {
  return useSync({
    uri,
    assets: boardAssets,
    ...(readonly ? { getUserPresence: () => null } : {}),
  });
}

export function BoardCanvas({
  store,
  readonly = false,
  onMount,
  onError,
}: {
  store: TLStore | TLStoreWithStatus;
  readonly?: boolean;
  onMount?: (editor: Editor) => void;
  onError?: (error: unknown) => void;
}) {
  const components = useMemo<TLComponents | undefined>(
    () =>
      onError
        ? {
            ErrorFallback: ({ error }) => <RenderErrorReporter error={error} onError={onError} />,
            ShapeErrorFallback: ({ error }) => (
              <RenderErrorReporter error={error} onError={onError} />
            ),
          }
        : undefined,
    [onError]
  );

  return (
    <Tldraw
      store={store}
      licenseKey={LICENSE_KEY}
      hideUi={readonly}
      autoFocus={!readonly}
      colorScheme={readonly ? "light" : "system"}
      overlayUtils={readonly ? HIDDEN_COLLABORATOR_OVERLAYS : undefined}
      options={readonly ? { zoomToFitPadding: 64 } : undefined}
      components={components}
      onMount={onMount}
    />
  );
}

function RenderErrorReporter({
  error,
  onError,
}: {
  error: unknown;
  onError: (error: unknown) => void;
}) {
  useEffect(() => onError(error), [error, onError]);
  return null;
}
