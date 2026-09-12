/**
 * Session Durable Object: the Cloudflare adapter for one session runtime.
 *
 * All application wiring lives in `createSessionRuntime` (session/components.ts),
 * which returns the narrow surface this class needs — the server entry points,
 * the session logger, and alarm rehydration. This class only initializes the
 * runtime per activation and forwards the platform callbacks.
 */

import { DurableObject } from "cloudflare:workers";
import { initSchema } from "../session/schema";
import type { Env } from "../types";
import { createDurableObjectSessionPlatform } from "./session-platform";
import { createCloudflareEnv, type WorkerBindings } from "./platform";
import { upgradeWebSocket } from "./websocket-upgrade";
import type { SessionPlatform } from "../session/platform";
import { createSessionRuntime, type SessionRuntime } from "../session/components";
import type { BackgroundTasks } from "../platform-ports";
import { ChildResultDelivery } from "../session/child-result-prompt";
import { buildSessionInternalRequest, SessionInternalPaths } from "../session/contracts";
import {
  childSessionUpdateBodySchema,
  type ChildSessionUpdateBody,
} from "../session/http/handlers/child-sessions.handler";

export class SessionDO extends DurableObject<WorkerBindings> {
  /**
   * This object's storage, sockets, alarm, and event lifetime as the ports
   * the runtime is built over, with the deployment's global store. The
   * constructor is the single point where env.DB is read; a missing binding
   * fails construction instead of running a degraded session.
   */
  private readonly platform: SessionPlatform;
  /** The application environment over this object's bindings. */
  private readonly appEnv: Env;
  /** The per-activation runtime; null until ensureInitialized() builds it. */
  private _runtime: SessionRuntime | null = null;
  /** Delivery over this object's storage; null until a childSessionUpdate needs it. */
  private _childResults: { delivery: ChildResultDelivery; tasks: BackgroundTasks } | null = null;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    // eslint-disable-next-line no-restricted-syntax -- composition root input: the DO's one env.DB read
    const db = env.DB;
    if (!db) {
      throw new Error(
        "SessionDO requires the DB binding; sessions cannot run without the global store"
      );
    }
    this.platform = createDurableObjectSessionPlatform(ctx, db);
    this.appEnv = createCloudflareEnv(env);
  }

  /** The runtime, (re)built on first touch after construction or eviction. */
  private get runtime(): SessionRuntime {
    this.ensureInitialized();
    return this._runtime!;
  }

  /**
   * Initialize the session runtime: apply the schema, then build the whole
   * collaborator graph eagerly. Every platform entry point calls this first.
   */
  private ensureInitialized(rehydrateAlarm = true): void {
    if (this._runtime) return;
    const initStart = performance.now();
    initSchema(this.platform.storage.sql);
    const runtime = createSessionRuntime(this.platform, this.appEnv);
    // Publish only after the graph is fully built: a throw above leaves the
    // activation uninitialized, so the next event retries initialization
    // instead of dereferencing an undefined runtime.
    this._runtime = runtime;
    runtime.log.info("do.init", {
      event: "do.init",
      duration_ms: Math.round((performance.now() - initStart) * 100) / 100,
    });
    if (rehydrateAlarm) {
      runtime.alarms.rehydrate();
    }
  }

  /**
   * Handle incoming HTTP requests. WebSocket upgrades are completed here,
   * on the Cloudflare side of the session, because only the host can turn
   * an admitted upgrade into a socket.
   */
  async fetch(request: Request): Promise<Response> {
    const runtime = this.runtime;
    if (request.headers.get("Upgrade") === "websocket") {
      return upgradeWebSocket(runtime.upgrades, request, runtime.log);
    }
    const childUpdate = await this.parseChildSessionUpdate(request);
    const response = await runtime.server.onRequest(request);
    if (childUpdate) this.deliverChildResultIfNeeded(childUpdate);
    return response;
  }

  /**
   * Child-result delivery for the childSessionUpdate route. Every child
   * status report arrives here, including the archive-cascade replays, so
   * routing the edge-trigger through this one path is what keeps a replay
   * from double-firing. Delivery runs past the response.
   */
  private deliverChildResultIfNeeded(update: ChildSessionUpdateBody): void {
    const { delivery, tasks } = this.childResults;
    if (!delivery.shouldDeliverFor(update.childSessionId, update.status, update.deliverResult)) {
      return;
    }
    const childSessionId = update.childSessionId;
    const { status } = update;
    tasks.submit(() => delivery.deliver(childSessionId, status), {
      name: "child_result.deliver",
      context: { child_session_id: childSessionId },
    });
  }

  private parseChildSessionUpdate(request: Request): Promise<ChildSessionUpdateBody | null> {
    const url = new URL(request.url);
    if (url.pathname !== SessionInternalPaths.childSessionUpdate || request.method !== "POST") {
      return Promise.resolve(null);
    }
    return request
      .clone()
      .json()
      .then((raw) => {
        const parsed = childSessionUpdateBodySchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      })
      .catch(() => null);
  }

  /** The delivery collaborators, built on first settled child update. */
  private get childResults(): { delivery: ChildResultDelivery; tasks: BackgroundTasks } {
    if (this._childResults) return this._childResults;
    const runtime = this.runtime;
    const sql = this.platform.storage.sql;
    const dispatch = this.appEnv.SESSION;
    this._childResults = {
      delivery: new ChildResultDelivery({
        sql,
        fetchChildSummary: (childSessionId) =>
          dispatch(
            childSessionId,
            buildSessionInternalRequest(
              SessionInternalPaths.childSummary,
              { method: "GET" },
              "?include=result"
            )
          ),
        resolveAuthorUserId: () => {
          const rows = sql
            .exec(
              "SELECT user_id FROM participants WHERE role = 'owner' ORDER BY joined_at LIMIT 1"
            )
            .toArray() as Array<{ user_id: string }>;
          return rows[0]?.user_id ?? null;
        },
        enqueueAgentPrompt: (request) => runtime.server.onRequest(request),
        log: runtime.log,
      }),
      tasks: this.platform.createBackgroundTasks(runtime.log),
    };
    return this._childResults;
  }

  /**
   * Handle WebSocket message (with hibernation support).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.runtime.server.onMessage(ws, message);
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await this.runtime.server.onClose(ws, code, reason, wasClean);
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.runtime.server.onError(ws, error);
  }

  /**
   * Durable Object alarm handler. Initializes without re-arming the alarm —
   * this delivery is the alarm — then delegates deadline handling.
   */
  async alarm(): Promise<void> {
    this.ensureInitialized(false);
    await this._runtime!.server.onScheduledDeadline();
  }
}
