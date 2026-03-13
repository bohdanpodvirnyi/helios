import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

const mockDb = { current: createTestDb() };
vi.mock("../store/database.js", () => {
  const getDb = () => mockDb.current;
  class StmtCache {
    private cache = new Map();
    stmt(sql: string) {
      let s = this.cache.get(sql);
      if (!s) { s = getDb().prepare(sql); this.cache.set(sql, s); }
      return s;
    }
  }
  return { getDb, StmtCache, getHeliosDir: () => "/tmp/helios-test" };
});

const { MetricStore } = await import("./store.js");

describe("MetricStore", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("inserts and retrieves a metric", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", {
      metricName: "loss",
      value: 0.5,
      timestamp: 1000,
    });

    const latest = store.getLatest("task1", "loss");
    expect(latest).not.toBeNull();
    expect(latest!.value).toBe(0.5);
  });

  it("returns null for missing metric", () => {
    const store = new MetricStore("agent1");
    expect(store.getLatest("task1", "nonexistent")).toBeNull();
  });

  it("getLatest returns most recent value", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1.0, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "loss", value: 0.5, timestamp: 2000 });
    store.insert("task1", "local", { metricName: "loss", value: 0.3, timestamp: 3000 });

    const latest = store.getLatest("task1", "loss");
    expect(latest!.value).toBe(0.3);
  });

  it("getSeries returns points in chronological order", () => {
    const store = new MetricStore("agent1");
    for (let i = 0; i < 5; i++) {
      store.insert("task1", "local", { metricName: "loss", value: 5 - i, timestamp: 1000 + i * 100 });
    }

    const series = store.getSeries("task1", "loss");
    expect(series).toHaveLength(5);
    expect(series[0].value).toBe(5); // earliest
    expect(series[4].value).toBe(1); // latest
  });

  it("getSeries respects limit", () => {
    const store = new MetricStore("agent1");
    for (let i = 0; i < 10; i++) {
      store.insert("task1", "local", { metricName: "loss", value: i, timestamp: 1000 + i });
    }

    const series = store.getSeries("task1", "loss", 3);
    expect(series).toHaveLength(3);
    // Should be the most recent 3, in ASC order
    expect(series[0].value).toBe(7);
    expect(series[2].value).toBe(9);
  });

  it("insertBatch inserts all points atomically", () => {
    const store = new MetricStore("agent1");
    const points = Array.from({ length: 100 }, (_, i) => ({
      metricName: "loss",
      value: Math.random(),
      timestamp: 1000 + i,
    }));

    store.insertBatch("task1", "local", points);
    const series = store.getSeries("task1", "loss", 200);
    expect(series).toHaveLength(100);
  });

  it("getMetricNames lists distinct names", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "acc", value: 0.9, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "loss", value: 0.5, timestamp: 2000 });

    const names = store.getMetricNames("task1");
    expect(names.sort()).toEqual(["acc", "loss"]);
  });

  it("getLatestAll returns latest value per metric", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1.0, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "loss", value: 0.5, timestamp: 2000 });
    store.insert("task1", "local", { metricName: "acc", value: 0.95, timestamp: 2000 });

    const all = store.getLatestAll("task1");
    expect(all.loss).toBe(0.5);
    expect(all.acc).toBe(0.95);
  });

  it("isolates by agentId", () => {
    const store1 = new MetricStore("agent1");
    const store2 = new MetricStore("agent2");

    store1.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 1000 });
    expect(store2.getLatest("task1", "loss")).toBeNull();
  });

  it("clearTask removes task metrics", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 1000 });
    store.insert("task2", "local", { metricName: "loss", value: 2, timestamp: 1000 });

    store.clearTask("task1");
    expect(store.getLatest("task1", "loss")).toBeNull();
    expect(store.getLatest("task2", "loss")).not.toBeNull();
  });

  it("clear removes all agent metrics", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 1000 });
    store.insert("task2", "local", { metricName: "acc", value: 0.9, timestamp: 1000 });

    const removed = store.clear();
    expect(removed).toBe(2);
    expect(store.getMetricNames("task1")).toEqual([]);
  });

  it("getAllSeries groups by metric name", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "loss", value: 0.5, timestamp: 2000 });
    store.insert("task1", "local", { metricName: "acc", value: 0.9, timestamp: 1000 });

    const all = store.getAllSeries(50);
    expect(all.get("loss")).toEqual([1, 0.5]);
    expect(all.get("acc")).toEqual([0.9]);
  });

  it("getTaskSummary returns min/max/latest/count", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 3, timestamp: 1000 });
    store.insert("task1", "local", { metricName: "loss", value: 1, timestamp: 2000 });
    store.insert("task1", "local", { metricName: "loss", value: 2, timestamp: 3000 });

    const summary = store.getTaskSummary("task1");
    expect(summary.loss).toMatchObject({
      latest: 2,
      min: 1,
      max: 3,
      count: 3,
    });
  });

  it("getLatestPerMetric aggregates across tasks", () => {
    const store = new MetricStore("agent1");
    store.insert("task1", "local", { metricName: "loss", value: 0.5, timestamp: 1000 });
    store.insert("task2", "local", { metricName: "loss", value: 0.3, timestamp: 2000 });

    const latest = store.getLatestPerMetric();
    expect(latest.loss).toBe(0.3);
  });
});
