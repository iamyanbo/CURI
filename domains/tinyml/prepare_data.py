"""Freeze the tinyml corpus into deterministic, hash-pinned splits.

Run once. Writes visible splits into domains/tinyml/data/ and the protected
holdout into .autoresearch-protected/splits/ where the executor cannot read or
write it. Split boundaries are byte offsets, so the split is reproducible from
the corpus hash alone.
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "domains" / "tinyml" / "data"
PROTECTED = ROOT / ".autoresearch-protected" / "splits"

CORPUS_SHA256 = "86c4e6aa9db7c042ec79f339dcb96d42b0075e16b8fc2e86bf0ca57e2dc565ed"

# Byte-offset fractions. Never change these without minting a new split_hash.
TRAIN_END = 0.90
VAL_END = 0.95  # visible dev split; the rest is the protected holdout


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    corpus_path = DATA / "corpus.txt"
    raw = corpus_path.read_bytes()
    actual = sha256(raw)
    if actual != CORPUS_SHA256:
        print(f"FATAL: corpus hash mismatch\n  expected {CORPUS_SHA256}\n  actual   {actual}")
        return 1

    text = raw.decode("utf-8")
    vocab = sorted(set(text))
    stoi = {c: i for i, c in enumerate(vocab)}

    n = len(text)
    a, b = int(n * TRAIN_END), int(n * VAL_END)
    splits = {"train": text[:a], "val": text[a:b], "holdout": text[b:]}

    PROTECTED.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)

    (DATA / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")

    manifest = {
        "corpus_sha256": CORPUS_SHA256,
        "corpus_bytes": n,
        "vocab_size": len(vocab),
        "boundaries": {"train_end": a, "val_end": b, "corpus_end": n},
        "splits": {},
    }

    for name, chunk in splits.items():
        ids = bytes(stoi[c] for c in chunk)  # vocab is 65, so one byte per token
        target = (PROTECTED if name == "holdout" else DATA) / f"{name}.bin"
        target.write_bytes(ids)
        manifest["splits"][name] = {
            "tokens": len(ids),
            "sha256": sha256(ids),
            "path": str(target.relative_to(ROOT)).replace("\\", "/"),
            "protected": name == "holdout",
        }

    manifest["split_hash"] = sha256(
        json.dumps(manifest["splits"], sort_keys=True).encode("utf-8")
    )

    out = DATA / "split_manifest.json"
    out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
