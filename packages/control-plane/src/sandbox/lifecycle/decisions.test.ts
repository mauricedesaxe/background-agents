/**
 * Unit tests for sandbox lifecycle decision functions.
 *
 * These are pure functions with no side effects, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateConnectingTimeout,
  evaluateWarmDecision,
  evaluateExecutionTimeout,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type SandboxState,
  type SpawnConfig,
  type InactivityState,
  type InactivityConfig,
  type HeartbeatConfig,
  type ConnectingTimeoutConfig,
  type WarmState,
  type ExecutionTimeoutConfig,
} from "./decisions";
import { addDuration, durationMs, elapsed, epochMs, nowMs } from "../../time";

// ==================== Circuit Breaker Tests ====================

describe("evaluateCircuitBreaker", () => {
  const config: CircuitBreakerConfig = {
    threshold: 3,
    windowMs: 5 * 60 * 1000, // 5 minutes
  };

  it("allows spawn when no failures", () => {
    const state: CircuitBreakerState = {
      failureCount: 0,
      lastFailureTime: 0,
    };
    const now = Date.now();

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(false);
    expect(decision.waitTimeMs).toBeUndefined();
  });

  it("allows spawn when failures below threshold", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 2,
      lastFailureTime: now - 60000, // 1 minute ago
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(false);
  });

  it("blocks spawn after threshold failures within window", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 3,
      lastFailureTime: now - 60000, // 1 minute ago
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(false);
    expect(decision.shouldReset).toBe(false);
    expect(decision.waitTimeMs).toBe(config.windowMs - 60000);
  });

  it("returns correct wait time when blocked", () => {
    const now = Date.now();
    const timeSinceFailure = 120000; // 2 minutes
    const state: CircuitBreakerState = {
      failureCount: 5,
      lastFailureTime: now - timeSinceFailure,
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(false);
    expect(decision.waitTimeMs).toBe(config.windowMs - timeSinceFailure);
  });

  it("signals reset when window passes", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 5,
      lastFailureTime: now - config.windowMs - 1000, // Window passed
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(true);
  });

  it("handles boundary timing (exact window)", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 3,
      lastFailureTime: now - config.windowMs, // Exactly at window boundary
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    // At exact boundary, should reset
    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(true);
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.threshold).toBe(3);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs).toBe(5 * 60 * 1000);
  });
});

// ==================== Spawn Decision Tests ====================

describe("evaluateSpawnDecision", () => {
  const config: SpawnConfig = {
    cooldownMs: 30000,
    readyWaitMs: 60000,
    spawningTimeoutMs: 120000,
  };

  it('returns "restore" when snapshot exists and sandbox is stopped', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
    if (decision.action === "restore") {
      expect(decision.snapshotImageId).toBe("img-abc123");
    }
  });

  it('returns "restore" when snapshot exists and sandbox is stale', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stale",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
  });

  it('returns "restore" when snapshot exists and sandbox is failed', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
  });

  it('returns "skip" when already spawning', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - 5000,
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("spawning");
    }
  });

  it('returns "skip" when connecting', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "connecting",
      createdAt: now - 5000,
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
  });

  it('returns "spawn" when stuck in "spawning" past the spawning timeout (recovers interrupted spawn)', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - (config.spawningTimeoutMs + 1000),
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it('returns "spawn" when stuck in "connecting" past the spawning timeout', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "connecting",
      createdAt: now - (config.spawningTimeoutMs + 1000),
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it('still skips a stale "spawning" when a spawn is in progress in-memory', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - (config.spawningTimeoutMs + 1000),
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

    expect(decision.action).toBe("skip");
  });

  it('returns "skip" when ready with active WebSocket', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "ready",
      createdAt: now - 120000,
      snapshotImageId: null,
      hasActiveWebSocket: true,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("active WebSocket");
    }
  });

  it('returns "wait" when ready without WebSocket but recent spawn', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "ready",
      createdAt: now - 30000, // 30 seconds ago, less than readyWaitMs
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("wait");
    if (decision.action === "wait") {
      expect(decision.reason).toContain("no WebSocket");
    }
  });

  it('returns "wait" during cooldown period', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 10000, // 10 seconds ago, less than cooldownMs
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("wait");
    if (decision.action === "wait") {
      expect(decision.reason).toContain("waiting");
    }
  });

  it('returns "skip" when isSpawningInMemory flag is set', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 60000,
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("in-memory flag");
    }
  });

  it('returns "spawn" when all conditions pass', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 60000, // Past cooldown
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("failed status bypasses cooldown", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 5000, // Within cooldown, but status is failed
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("stopped status bypasses cooldown", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 5000, // Within cooldown, but status is stopped
      snapshotImageId: null, // No snapshot, so fresh spawn
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_SPAWN_CONFIG.cooldownMs).toBe(30000);
    expect(DEFAULT_SPAWN_CONFIG.readyWaitMs).toBe(60000);
  });

  // ---- Persistent resume (Daytona-style) ----

  it('returns "resume" when provider supports persistent resume and sandbox is stopped with providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
    if (decision.action === "resume") {
      expect(decision.providerObjectId).toBe("daytona-abc123");
    }
  });

  it('returns "resume" when provider supports persistent resume and sandbox is stale with providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stale",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
  });

  it("resume takes priority over restore when both available", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: "img-abc123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
  });

  it('falls back to "restore" when supportsPersistentResume but no providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: null,
      snapshotImageId: "img-abc123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("restore");
  });

  it('falls back to "spawn" when supportsPersistentResume but no providerObjectId and no snapshot', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: null,
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("spawn");
  });

  it("does not resume when supportsPersistentResume is false even with providerObjectId", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, false);

    expect(decision.action).toBe("spawn");
  });

  it("does not resume for failed status even with providerObjectId", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    // "failed" is not a resume-eligible status — should fall through to spawn
    expect(decision.action).toBe("spawn");
  });
});

// ==================== Inactivity Timeout Tests ====================

describe("evaluateInactivityTimeout", () => {
  const config: InactivityConfig = {
    timeoutMs: durationMs(10 * 60 * 1000),
    extensionMs: durationMs(5 * 60 * 1000),
    minCheckIntervalMs: durationMs(30 * 1000),
  };

  it('returns "schedule" for terminal states (stopped)', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 60000), // Well past timeout
      status: "stopped",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it('returns "schedule" for terminal states (failed)', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 60000),
      status: "failed",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "schedule" for terminal states (stale)', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 60000),
      status: "stale",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "schedule" when no lastActivity', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: null,
      status: "ready",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it('returns "timeout" when inactivity exceeds threshold with no clients', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 1000), // Just past timeout
      status: "ready",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("timeout");
    if (decision.action === "timeout") {
      expect(decision.shouldSnapshot).toBe(true);
    }
  });

  it('returns "extend" when threshold exceeded but clients connected', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 1000),
      status: "ready",
      connectedClientCount: 2,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("extend");
    if (decision.action === "extend") {
      // What's left of the window, not a fresh extensionMs: this alarm is a
      // second late, so the grant is a second short.
      expect(decision.extensionMs).toBe(config.extensionMs - 1000);
      expect(decision.shouldWarn).toBe(true);
    }
  });

  it('returns "schedule" with correct remaining time', () => {
    const now = nowMs();
    const inactiveTime = 5 * 60 * 1000; // 5 minutes
    const state: InactivityState = {
      lastActivityMs: epochMs(now - inactiveTime),
      status: "ready",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.timeoutMs - inactiveTime);
    }
  });

  it("handles minimum check interval", () => {
    const now = nowMs();
    // 9 minutes 50 seconds - very close to timeout
    const inactiveTime = config.timeoutMs - 10000;
    const state: InactivityState = {
      lastActivityMs: epochMs(now - inactiveTime),
      status: "ready",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      // Should be max of remaining time (10s) and min interval (30s)
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it("only applies to ready/running status", () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 60000),
      status: "spawning", // Not ready or running
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "timeout" for running status', () => {
    const now = nowMs();
    const state: InactivityState = {
      lastActivityMs: epochMs(now - config.timeoutMs - 1000),
      status: "running",
      connectedClientCount: 0,
      isProcessing: false,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("timeout");
  });

  describe("extension is bounded", () => {
    it('returns "timeout" once the extension is spent, even with clients connected', () => {
      const now = nowMs();
      const state: InactivityState = {
        lastActivityMs: epochMs(now - (config.timeoutMs + config.extensionMs)),
        status: "ready",
        connectedClientCount: 2,
        isProcessing: false,
      };

      const decision = evaluateInactivityTimeout(state, config, now);

      expect(decision.action).toBe("timeout");
    });

    it("stops a sandbox held open by a client that never sends anything", () => {
      // The extension used to be granted on every alarm without touching
      // lastActivity, so a connected client extended forever and the sandbox
      // only ever died at the provider's own backstop.
      const lastActivityMs = nowMs();
      const state: InactivityState = {
        lastActivityMs,
        status: "ready",
        connectedClientCount: 1,
        isProcessing: false,
      };

      // Walk the alarm chain forward as the manager would: each decision
      // schedules the next check, and lastActivityMs never moves because the
      // client is connected but silent.
      let now = addDuration(lastActivityMs, config.timeoutMs);
      const actions: string[] = [];
      for (let i = 0; i < 10; i++) {
        const decision = evaluateInactivityTimeout(state, config, now);
        actions.push(decision.action);
        if (decision.action === "timeout") break;
        now = addDuration(
          now,
          decision.action === "extend" ? decision.extensionMs : decision.nextCheckMs
        );
      }

      expect(actions).toEqual(["extend", "timeout"]);
      expect(elapsed(lastActivityMs, now)).toBe(config.timeoutMs + config.extensionMs);
    });

    it("holds the bound when the alarm arrives late", () => {
      // Alarms are not punctual. A late one used to be granted a fresh full
      // extension, which pushed the deadline out past the bound rather than up
      // to it: at 14 minutes idle, a 5-minute grant meant death at 19.
      const lastActivityMs = nowMs();
      const lateBy = durationMs(4 * 60 * 1000);
      const now = addDuration(lastActivityMs, durationMs(config.timeoutMs + lateBy));
      const state: InactivityState = {
        lastActivityMs,
        status: "ready",
        connectedClientCount: 1,
        isProcessing: false,
      };

      const decision = evaluateInactivityTimeout(state, config, now);

      expect(decision.action).toBe("extend");
      if (decision.action !== "extend") return;
      const death = addDuration(now, decision.extensionMs);
      expect(elapsed(lastActivityMs, death)).toBe(config.timeoutMs + config.extensionMs);
    });
  });

  describe("in-flight runs", () => {
    it('returns "schedule" rather than "timeout" while a message is processing', () => {
      const now = nowMs();
      const state: InactivityState = {
        lastActivityMs: epochMs(now - config.timeoutMs - 1000),
        status: "ready",
        connectedClientCount: 0,
        isProcessing: true,
      };

      const decision = evaluateInactivityTimeout(state, config, now);

      expect(decision.action).toBe("schedule");
    });

    it("does not stop a run that has been silent far longer than the timeout", () => {
      const now = nowMs();
      const state: InactivityState = {
        lastActivityMs: epochMs(now - 80 * 60 * 1000),
        status: "ready",
        connectedClientCount: 0,
        isProcessing: true,
      };

      const decision = evaluateInactivityTimeout(state, config, now);

      expect(decision.action).toBe("schedule");
    });

    it('returns "timeout" once the message is no longer processing', () => {
      const now = nowMs();
      const state: InactivityState = {
        lastActivityMs: epochMs(now - config.timeoutMs - 1000),
        status: "ready",
        connectedClientCount: 0,
        isProcessing: false,
      };

      const decision = evaluateInactivityTimeout(state, config, now);

      expect(decision.action).toBe("timeout");
    });
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_INACTIVITY_CONFIG.timeoutMs).toBe(10 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_CONFIG.extensionMs).toBe(5 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_CONFIG.minCheckIntervalMs).toBe(30000);
  });
});

// ==================== Heartbeat Health Tests ====================

describe("evaluateHeartbeatHealth", () => {
  const config: HeartbeatConfig = {
    timeoutMs: 90000, // 90 seconds
  };

  it("returns not stale when no heartbeat recorded", () => {
    const now = Date.now();

    const health = evaluateHeartbeatHealth(null, config, now);

    expect(health.isStale).toBe(false);
    expect(health.ageMs).toBeUndefined();
  });

  it("returns not stale when heartbeat is recent", () => {
    const now = Date.now();
    const lastHeartbeat = now - 30000; // 30 seconds ago

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(false);
    expect(health.ageMs).toBeUndefined();
  });

  it("returns stale when heartbeat exceeds timeout", () => {
    const now = Date.now();
    const lastHeartbeat = now - 100000; // 100 seconds ago (> 90s timeout)

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(100000);
  });

  it("returns correct age in milliseconds", () => {
    const now = Date.now();
    const ageMs = 150000;
    const lastHeartbeat = now - ageMs;

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(ageMs);
  });

  it("handles boundary timing (exactly at timeout)", () => {
    const now = Date.now();
    const lastHeartbeat = now - config.timeoutMs; // Exactly at timeout

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    // At exact boundary, not stale (> vs >=)
    expect(health.isStale).toBe(false);
  });

  it("handles boundary timing (just past timeout)", () => {
    const now = Date.now();
    const lastHeartbeat = now - config.timeoutMs - 1; // Just past timeout

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(config.timeoutMs + 1);
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_HEARTBEAT_CONFIG.timeoutMs).toBe(90000);
  });
});

// ==================== Connecting Timeout Tests ====================

describe("evaluateConnectingTimeout", () => {
  const config: ConnectingTimeoutConfig = DEFAULT_CONNECTING_TIMEOUT_CONFIG;

  it("returns not timed out for non-connecting status", () => {
    const now = Date.now();
    const result = evaluateConnectingTimeout("ready", now - 200_000, config, now);

    expect(result.isTimedOut).toBe(false);
    expect(result.elapsedMs).toBe(0);
  });

  it("returns not timed out when within timeout window", () => {
    const now = Date.now();
    const createdAt = now - 60_000; // 60s ago, well within 120s timeout

    const result = evaluateConnectingTimeout("connecting", createdAt, config, now);

    expect(result.isTimedOut).toBe(false);
    expect(result.elapsedMs).toBe(60_000);
  });

  it("returns timed out when past timeout", () => {
    const now = Date.now();
    const createdAt = now - 130_000; // 130s ago, past 120s timeout

    const result = evaluateConnectingTimeout("connecting", createdAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(130_000);
  });

  it("returns timed out at exact boundary (>=)", () => {
    const now = Date.now();
    const createdAt = now - config.timeoutMs; // Exactly at timeout

    const result = evaluateConnectingTimeout("connecting", createdAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(config.timeoutMs);
  });

  it("returns timed out when stuck in spawning past timeout (interrupted spawn)", () => {
    const now = Date.now();
    const createdAt = now - 130_000; // 130s ago, past 120s timeout

    const result = evaluateConnectingTimeout("spawning", createdAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(130_000);
  });

  it("returns not timed out for spawning within timeout window", () => {
    const now = Date.now();
    const result = evaluateConnectingTimeout("spawning", now - 60_000, config, now);

    expect(result.isTimedOut).toBe(false);
  });

  it("ignores all non-spawning/connecting statuses", () => {
    const now = Date.now();
    const old = now - 999_999;

    for (const status of ["pending", "ready", "running", "stopped", "failed", "stale"] as const) {
      const result = evaluateConnectingTimeout(status, old, config, now);
      expect(result.isTimedOut).toBe(false);
    }
  });

  it("uses correct default config value", () => {
    expect(DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs).toBe(120_000);
  });
});

// ==================== Warm Decision Tests ====================

describe("evaluateWarmDecision", () => {
  it('returns "skip" when sandbox already connected', () => {
    const state: WarmState = {
      hasActiveWebSocket: true,
      status: "ready",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("already connected");
    }
  });

  it('returns "skip" when already spawning (in-memory)', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "pending",
      isSpawningInMemory: true,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("already spawning");
    }
  });

  it('returns "skip" when sandbox status is spawning', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "spawning",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("spawning");
    }
  });

  it('returns "skip" when sandbox status is connecting', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "connecting",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("connecting");
    }
  });

  it('returns "spawn" when conditions pass', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "pending",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("spawn");
  });

  it('returns "spawn" when status is null', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: null,
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("spawn");
  });
});

// ==================== Execution Timeout Tests ====================

describe("evaluateExecutionTimeout", () => {
  const config: ExecutionTimeoutConfig = {
    timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS, // 90 minutes
  };

  it("returns not timed out within threshold", () => {
    const now = Date.now();
    const startedAt = now - 60000; // 1 minute ago

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(false);
    expect(result.elapsedMs).toBe(60000);
  });

  it("returns timed out past threshold", () => {
    const now = Date.now();
    const startedAt = now - DEFAULT_EXECUTION_TIMEOUT_MS - 1000; // Just past 90 minutes

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS + 1000);
  });

  it("returns timed out at exact threshold", () => {
    const now = Date.now();
    const startedAt = now - DEFAULT_EXECUTION_TIMEOUT_MS;

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
  });

  it("works with custom timeout config", () => {
    const customConfig: ExecutionTimeoutConfig = { timeoutMs: 5000 };
    const now = Date.now();
    const startedAt = now - 6000;

    const result = evaluateExecutionTimeout(startedAt, customConfig, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(6000);
  });
});
