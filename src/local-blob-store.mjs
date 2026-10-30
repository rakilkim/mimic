export class LocalBlobStore {
  constructor() {
    this.entries = new Map();
    this.revision = 0;
  }

  async getWithMetadata(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      data: structuredClone(entry.data),
      etag: entry.etag,
      metadata: structuredClone(entry.metadata),
    };
  }

  async setJSON(key, value, options = {}) {
    const current = this.entries.get(key);
    if (options.onlyIfNew && current) return { modified: false };
    if (options.onlyIfMatch !== undefined && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = `"local-${++this.revision}"`;
    this.entries.set(key, {
      data: structuredClone(value),
      etag,
      metadata: structuredClone(options.metadata || {}),
    });
    return { modified: true, etag };
  }

  async list({ prefix = '' } = {}) {
    const blobs = [...this.entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, etag: entry.etag }));
    return { blobs };
  }

  async delete(key) {
    this.entries.delete(key);
  }
}
