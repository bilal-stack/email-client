// Pure logic test — no React render. Zustand stores are framework-agnostic
// so we drive them through `useInboxSelection.getState()`. The store is a
// singleton across imports, so we reset it before each test.

import { beforeEach, describe, expect, it } from "vitest";
import { useInboxSelection } from "./selection-store";

beforeEach(() => {
  useInboxSelection.getState().clear();
});

describe("useInboxSelection", () => {
  it("toggle adds an id when absent and removes it when present", () => {
    const { toggle, has } = useInboxSelection.getState();

    toggle("t1");
    expect(useInboxSelection.getState().has("t1")).toBe(true);

    useInboxSelection.getState().toggle("t1");
    expect(useInboxSelection.getState().has("t1")).toBe(false);
    // `has` is reactive: re-read from state. The closed-over `has` from earlier
    // still works because it reads from the latest store state.
    expect(has("t1")).toBe(false);
  });

  it("clear empties the set", () => {
    const s = useInboxSelection.getState();
    s.toggle("a");
    s.toggle("b");
    expect(useInboxSelection.getState().asArray()).toHaveLength(2);

    useInboxSelection.getState().clear();
    expect(useInboxSelection.getState().asArray()).toEqual([]);
    expect(useInboxSelection.getState().size).toBe(0);
  });

  it("selectMany replaces existing selection", () => {
    const s = useInboxSelection.getState();
    s.toggle("a");
    s.toggle("b");

    useInboxSelection.getState().selectMany(["x", "y", "z"]);

    const arr = useInboxSelection.getState().asArray();
    expect(arr).toEqual(["x", "y", "z"]);
    expect(useInboxSelection.getState().has("a")).toBe(false);
    expect(useInboxSelection.getState().has("b")).toBe(false);
  });

  it("has returns correct boolean", () => {
    const s = useInboxSelection.getState();
    s.toggle("alpha");
    expect(useInboxSelection.getState().has("alpha")).toBe(true);
    expect(useInboxSelection.getState().has("beta")).toBe(false);
  });

  it("asArray returns ids in insertion order", () => {
    const s = useInboxSelection.getState();
    s.toggle("c");
    s.toggle("a");
    s.toggle("b");

    expect(useInboxSelection.getState().asArray()).toEqual(["c", "a", "b"]);
  });

  it("size tracks the selected count after toggle / selectMany / clear", () => {
    const s = useInboxSelection.getState();

    s.toggle("a");
    expect(useInboxSelection.getState().size).toBe(1);

    s.toggle("b");
    expect(useInboxSelection.getState().size).toBe(2);

    s.toggle("a"); // remove
    expect(useInboxSelection.getState().size).toBe(1);

    useInboxSelection.getState().selectMany(["x", "y", "z"]);
    expect(useInboxSelection.getState().size).toBe(3);

    useInboxSelection.getState().clear();
    expect(useInboxSelection.getState().size).toBe(0);
  });
});
