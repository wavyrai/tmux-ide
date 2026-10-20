const Buffer2=Buffer;const MAX_ENTRIES=8,MAX_ENTRY_BYTES=4*1024*1024,MAX_TOTAL_BYTES=16*1024*1024;
function createRetainedFrameCache() {
  const entries = /* @__PURE__ */ new Map();
  let total = 0;
  const remove = (key2) => {
    const entry = entries.get(key2);
    if (entry) {
      total -= entry.bytes;
      entries.delete(key2);
    }
  };
  return {
    remember(key2, proof, snapshot2) {
      remove(key2);
      if (!key2 || !proof || key2.length > 16384 || proof.length > 16384) return false;
      let json2;
      try {
        json2 = JSON.stringify(snapshot2);
      } catch {
        return false;
      }
      const bytes = Buffer2.byteLength(json2);
      if (bytes > MAX_ENTRY_BYTES) return false;
      while (entries.size >= MAX_ENTRIES || total + bytes > MAX_TOTAL_BYTES) {
        const oldest = entries.keys().next().value;
        if (oldest === void 0) return false;
        remove(oldest);
      }
      entries.set(key2, { proof, json: json2, bytes });
      total += bytes;
      return true;
    },
    preview(key2, proof) {
      const entry = entries.get(key2);
      if (!entry) return null;
      if (entry.proof !== proof) {
        remove(key2);
        return null;
      }
      entries.delete(key2);
      entries.set(key2, entry);
      return entry.json;
    },
    retain(keys) {
      const allowed = new Set(keys);
      for (const key2 of entries.keys()) if (!allowed.has(key2)) remove(key2);
    },
    clear() {
      entries.clear();
      total = 0;
    }
  };
}

export {createRetainedFrameCache};
