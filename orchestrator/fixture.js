'use strict';
// Shadow-fixture reader: task.shadow carries the canned answers every scripted/llm step
// consults instead of spawning or calling out. See orchestrator/README.md "fixture format".
//
// Convention (deliberately simple -- the whole point of shadow mode is that nothing here is
// ambiguous):
//   - a scalar value (number, string, boolean, object) is returned unchanged on every call;
//   - an array is consumed one element per call to that same key, in order (a per-key,
//     per-task cursor that advances every time fixture(key, ...) is invoked -- irrespective of
//     which orchestrator state or which retry loop is doing the calling: e.g. "prWait" is
//     consumed twice within a single MERGE visit -- the initial wait and its one bounded
//     re-wait -- while "gate" is consumed once per GATE-state visit across the whole task);
//   - once an array is exhausted, its last element repeats for every further call. Tests size
//     their fixture arrays to the exact number of calls a scenario needs, so this only matters
//     as a defensive default, never as load-bearing behaviour;
//   - a missing key (undefined) or an explicit null returns the caller's defaultValue.
//
// keyPath supports dotted lookup ("llm.PLAN", "delays.IMPLEMENT") into task.shadow.

function getByPath(obj, dottedKey) {
  return dottedKey.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function makeFixtureReader(task) {
  const shadow = (task && task.shadow) || {};
  const cursors = new Map();

  return function fixture(keyPath, defaultValue) {
    const raw = getByPath(shadow, keyPath);
    if (raw === undefined || raw === null) return defaultValue;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return defaultValue;
      const i = cursors.get(keyPath) || 0;
      cursors.set(keyPath, i + 1);
      const idx = Math.min(i, raw.length - 1);
      return raw[idx];
    }
    return raw;
  };
}

module.exports = { makeFixtureReader, getByPath };
