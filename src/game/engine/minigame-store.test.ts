import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { minigameStore } from "./minigame-store.ts";

/** An in-memory `localStorage`, the browser's key/value store. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

function useStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
}

describe("given the minigame bests in an in-memory localStorage", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
    useStorage(storage);
  });
  afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

  it("when nothing was recorded, then every best reads as none", () => {
    assert.deepEqual(minigameStore().bestFor("longJump", null, "sedan"), { thisCar: null, overall: null }, "empty store");
  });

  it("when a score is recorded, then it reads back as the car type's best and the overall best, and the record is a new best", () => {
    const store = minigameStore();
    assert.equal(store.record("longJump", null, "sedan", 42.5), true, "first score is a new best");
    assert.deepEqual(store.bestFor("longJump", null, "sedan"), { thisCar: 42.5, overall: 42.5 }, "after the first score");
  });

  it("when two car types score, then each keeps its own best and the overall is the higher", () => {
    const store = minigameStore();
    store.record("highJump", null, "sedan", 12);
    store.record("highJump", null, "monster", 20);
    assert.deepEqual(store.bestFor("highJump", null, "sedan"), { thisCar: 12, overall: 20 }, "the sedan");
    assert.deepEqual(store.bestFor("highJump", null, "monster"), { thisCar: 20, overall: 20 }, "the monster");
    assert.equal(store.record("highJump", null, "sedan", 15), true, "a better sedan score that is still under the overall is a new best for the car");
    assert.deepEqual(store.bestFor("highJump", null, "sedan"), { thisCar: 15, overall: 20 }, "the sedan after beating itself");
  });

  it("when a lower or equal score is recorded, then the best is not overwritten and the record is not a new best", () => {
    const store = minigameStore();
    store.record("longJump", null, "sedan", 50);
    assert.equal(store.record("longJump", null, "sedan", 30), false, "lower score");
    assert.equal(store.record("longJump", null, "sedan", 50), false, "equal score");
    assert.deepEqual(store.bestFor("longJump", null, "sedan"), { thisCar: 50, overall: 50 }, "best kept");
  });

  it("when modes score, then each mode keeps its own bests", () => {
    const store = minigameStore();
    store.record("longJump", null, "sedan", 60);
    store.record("highJump", null, "sedan", 9);
    assert.deepEqual(store.bestFor("highJump", null, "sedan"), { thisCar: 9, overall: 9 }, "high jump");
    assert.deepEqual(store.bestFor("longJump", null, "sedan"), { thisCar: 60, overall: 60 }, "long jump");
  });

  it("when a new store is made on the same storage (a reload), then the bests are still there", () => {
    minigameStore().record("ringFling", 5, "truck", 240);
    const reloaded = minigameStore();
    assert.deepEqual(reloaded.bestFor("ringFling", 5, "truck"), { thisCar: 240, overall: 240 }, "after the reload");
    assert.equal(reloaded.record("ringFling", 5, "truck", 200), false, "the reloaded store still knows the best");
  });

  it("when Ring Fling sets of different lengths score, then their bests are kept apart", () => {
    const store = minigameStore();
    store.record("ringFling", 5, "sedan", 300);
    store.record("ringFling", 3, "sedan", 90);
    assert.deepEqual(store.bestFor("ringFling", 5, "sedan"), { thisCar: 300, overall: 300 }, "five-throw sets");
    assert.deepEqual(store.bestFor("ringFling", 3, "sedan"), { thisCar: 90, overall: 90 }, "three-throw sets");
    assert.deepEqual(store.bestFor("ringFling", 4, "sedan"), { thisCar: null, overall: null }, "a length never played");
  });

  it("when scores are recorded, then they live under crush.minigame.best.<mode>[.<throwsPerSet>].<carType|overall>", () => {
    const store = minigameStore();
    store.record("longJump", null, "wagon", 11);
    store.record("ringFling", 5, "wagon", 70);
    assert.equal(storage.getItem("crush.minigame.best.longJump.wagon"), "11", "long jump car key");
    assert.equal(storage.getItem("crush.minigame.best.longJump.overall"), "11", "long jump overall key");
    assert.equal(storage.getItem("crush.minigame.best.ringFling.5.wagon"), "70", "ring fling car key");
    assert.equal(storage.getItem("crush.minigame.best.ringFling.5.overall"), "70", "ring fling overall key");
  });

  it("when a score of 0 or less is recorded, then nothing is kept and it is not a new best", () => {
    const store = minigameStore();
    assert.equal(store.record("longJump", null, "sedan", 0), false, "zero score");
    assert.equal(storage.length, 0, "nothing stored");
  });

  it("when a stored value is not a score, then the best reads as none", () => {
    storage.setItem("crush.minigame.best.longJump.sedan", "not a number");
    assert.deepEqual(minigameStore().bestFor("longJump", null, "sedan"), { thisCar: null, overall: null }, "garbage in storage");
  });

  it("when the storage is blocked, then reading and recording do not throw, reads are none and the record is a new best", () => {
    useStorage({
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const store = minigameStore();
    assert.deepEqual(store.bestFor("longJump", null, "sedan"), { thisCar: null, overall: null }, "read from blocked storage");
    assert.equal(store.record("longJump", null, "sedan", 33), true, "record in blocked storage");
  });

  it("when there is no localStorage at all, then reading and recording do not throw", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    const store = minigameStore();
    assert.deepEqual(store.bestFor("highJump", null, "sedan"), { thisCar: null, overall: null }, "read without storage");
    assert.equal(store.record("highJump", null, "sedan", 4), true, "record without storage");
  });
});
