import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Storage } from "@google-cloud/storage";

export interface StoredArtifact {
  uri: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactStore {
  put(key: string, content: Buffer): Promise<StoredArtifact>;
  get(key: string, expectedSha256?: string): Promise<Buffer>;
}

const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");

function safeKey(root: string, key: string): string {
  if (isAbsolute(key)) throw new Error("artifact keys must be relative");
  const base = resolve(root);
  const target = resolve(base, key);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("artifact key escapes the store root");
  return target;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {}
  async put(key: string, content: Buffer): Promise<StoredArtifact> {
    const target = safeKey(this.root, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { uri: target, sha256: digest(content), bytes: content.length };
  }
  async get(key: string, expectedSha256?: string): Promise<Buffer> {
    const content = readFileSync(safeKey(this.root, key));
    const actual = digest(content);
    if (expectedSha256 && actual !== expectedSha256) throw new Error(`artifact hash mismatch: expected ${expectedSha256}, got ${actual}`);
    return content;
  }
}

export class GcsArtifactStore implements ArtifactStore {
  readonly storage: Storage;
  constructor(readonly bucketName: string, storage = new Storage()) { this.storage = storage; }
  async put(key: string, content: Buffer): Promise<StoredArtifact> {
    if (isAbsolute(key) || key.split("/").includes("..")) throw new Error("invalid GCS artifact key");
    const sha256 = digest(content);
    await this.storage.bucket(this.bucketName).file(key).save(content, {
      resumable: false,
      metadata: { contentType: "application/octet-stream", metadata: { sha256 } },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    return { uri: `gs://${this.bucketName}/${key}`, sha256, bytes: content.length };
  }
  async get(key: string, expectedSha256?: string): Promise<Buffer> {
    const [content] = await this.storage.bucket(this.bucketName).file(key).download();
    const actual = digest(content);
    if (expectedSha256 && actual !== expectedSha256) throw new Error(`artifact hash mismatch: expected ${expectedSha256}, got ${actual}`);
    return content;
  }
}
