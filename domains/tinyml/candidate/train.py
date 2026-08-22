"""tinyml baseline: char-level transformer, CPU, bitwise deterministic.

THIS IS THE CANDIDATE FILE. The executor edits this file (and config.json) and
nothing else. Rules enforced outside this file, not by it:

  * .autoresearch-protected/** is unreadable and unwritable here.
  * The metric printed on stdout is NOT the accepted metric. The protected
    evaluator reloads model.pt and recomputes bits-per-char independently.
  * Seeds come from the contract seed policy via config.json. Sweeping seeds
    inside this file and reporting the best is a registered shortcut.

Determinism contract: identical config + identical seed + identical environment
hash must produce a bitwise-identical model.pt. Any drift is a red flag.
"""

import hashlib
import json
import math
import os
import pathlib
import random
import time

# Must be set before torch import to bind the thread pool deterministically.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = pathlib.Path(__file__).resolve().parent
# The harness runs this file from an isolated git worktree, so the data root is
# supplied by the harness rather than inferred from this file's location.
DATA = pathlib.Path(os.environ["TINYML_DATA"]) if os.environ.get("TINYML_DATA")     else HERE.parents[2] / "domains" / "tinyml" / "data"


def set_determinism(seed: int) -> None:
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(seed)
    np.random.seed(seed)
    random.seed(seed)
    torch.set_num_threads(1)


class Block(nn.Module):
    def __init__(self, d_model: int, n_head: int, mlp_ratio: int):
        super().__init__()
        self.n_head = n_head
        self.ln1 = nn.LayerNorm(d_model)
        self.ln2 = nn.LayerNorm(d_model)
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.proj = nn.Linear(d_model, d_model, bias=False)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, mlp_ratio * d_model, bias=False),
            nn.GELU(),
            nn.Linear(mlp_ratio * d_model, d_model, bias=False),
        )

    def forward(self, x):
        b, t, c = x.shape
        h = self.ln1(x)
        q, k, v = self.qkv(h).split(c, dim=2)
        q = q.view(b, t, self.n_head, c // self.n_head).transpose(1, 2)
        k = k.view(b, t, self.n_head, c // self.n_head).transpose(1, 2)
        v = v.view(b, t, self.n_head, c // self.n_head).transpose(1, 2)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        a = a.transpose(1, 2).contiguous().view(b, t, c)
        x = x + self.proj(a)
        return x + self.mlp(self.ln2(x))


class CharLM(nn.Module):
    def __init__(self, vocab: int, d_model: int, n_layer: int, n_head: int, block: int, mlp_ratio: int):
        super().__init__()
        self.block_size = block
        self.tok = nn.Embedding(vocab, d_model)
        self.pos = nn.Embedding(block, d_model)
        self.blocks = nn.ModuleList([Block(d_model, n_head, mlp_ratio) for _ in range(n_layer)])
        self.lnf = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab, bias=False)

    def forward(self, idx):
        b, t = idx.shape
        x = self.tok(idx) + self.pos(torch.arange(t, device=idx.device))
        for blk in self.blocks:
            x = blk(x)
        return self.head(self.lnf(x))


def load_split(name: str) -> np.ndarray:
    return np.frombuffer((DATA / f"{name}.bin").read_bytes(), dtype=np.uint8).astype(np.int64)


def batches(data: np.ndarray, batch: int, block: int, gen: torch.Generator):
    ix = torch.randint(len(data) - block - 1, (batch,), generator=gen)
    x = torch.stack([torch.from_numpy(data[i : i + block]) for i in ix.tolist()])
    y = torch.stack([torch.from_numpy(data[i + 1 : i + 1 + block]) for i in ix.tolist()])
    return x, y


@torch.no_grad()
def bits_per_char(model: nn.Module, data: np.ndarray, block: int, batch: int, limit: int) -> float:
    """Deterministic sequential sweep — no sampling, so no seed sensitivity."""
    model.eval()
    total_nll, total_tok = 0.0, 0
    stride = block
    positions = list(range(0, min(len(data) - block - 1, limit), stride))
    for s in range(0, len(positions), batch):
        chunk = positions[s : s + batch]
        x = torch.stack([torch.from_numpy(data[p : p + block]) for p in chunk])
        y = torch.stack([torch.from_numpy(data[p + 1 : p + 1 + block]) for p in chunk])
        logits = model(x)
        nll = F.cross_entropy(logits.view(-1, logits.size(-1)), y.reshape(-1), reduction="sum")
        total_nll += float(nll)
        total_tok += y.numel()
    model.train()
    return total_nll / total_tok / math.log(2)


def main() -> int:
    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    seed = int(cfg["seed"])
    set_determinism(seed)

    vocab = json.loads((DATA / "vocab.json").read_text(encoding="utf-8"))
    train_data, val_data = load_split("train"), load_split("val")

    model = CharLM(
        vocab=len(vocab),
        d_model=cfg["d_model"],
        n_layer=cfg["n_layer"],
        n_head=cfg["n_head"],
        block=cfg["block_size"],
        mlp_ratio=cfg["mlp_ratio"],
    )
    n_params = sum(p.numel() for p in model.parameters())

    opt = torch.optim.AdamW(
        model.parameters(),
        lr=cfg["lr"],
        weight_decay=cfg["weight_decay"],
        betas=(cfg["beta1"], cfg["beta2"]),
    )

    gen = torch.Generator().manual_seed(seed)
    steps, warmup = cfg["steps"], cfg["warmup_steps"]
    started = time.time()
    log = []

    for step in range(steps):
        lr_scale = (step + 1) / max(1, warmup) if step < warmup else 0.5 * (
            1 + math.cos(math.pi * (step - warmup) / max(1, steps - warmup))
        )
        for g in opt.param_groups:
            g["lr"] = cfg["lr"] * lr_scale

        x, y = batches(train_data, cfg["batch_size"], cfg["block_size"], gen)
        logits = model(x)
        loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        if cfg.get("grad_clip"):
            torch.nn.utils.clip_grad_norm_(model.parameters(), cfg["grad_clip"])
        opt.step()

        if (step + 1) % cfg["log_every"] == 0:
            log.append({"step": step + 1, "train_loss": loss.detach().item()})

    val_bpc = bits_per_char(model, val_data, cfg["block_size"], cfg["batch_size"], cfg["eval_tokens"])

    out = HERE / "out"
    out.mkdir(exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "config": cfg, "vocab_size": len(vocab)}, out / "model.pt")
    model_sha = hashlib.sha256((out / "model.pt").read_bytes()).hexdigest()

    result = {
        "val_bpc_self_reported": val_bpc,
        "n_params": n_params,
        "seed": seed,
        "steps": steps,
        "wall_seconds": round(time.time() - started, 3),
        "model_sha256": model_sha,
        "log": log,
    }
    (out / "train_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")

    # Convenience only. The harness does not trust this line; the protected
    # evaluator recomputes the metric from model.pt.
    print(f"val_bpc={val_bpc:.6f} params={n_params} sha={model_sha[:16]} t={result['wall_seconds']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# ---------------------------------------------------------------------------
# STABLE EVALUATION INTERFACE — required by the protected evaluator.
# The executor MAY change the architecture above, but MUST keep this function
# working: given a checkpoint written by main(), return a model in eval mode.
# The evaluator supplies its own data and computes its own metric; nothing this
# file prints or stores is trusted.
# ---------------------------------------------------------------------------
def load_for_eval(ckpt_path):
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    cfg = ckpt["config"]
    model = CharLM(
        vocab=ckpt["vocab_size"],
        d_model=cfg["d_model"],
        n_layer=cfg["n_layer"],
        n_head=cfg["n_head"],
        block=cfg["block_size"],
        mlp_ratio=cfg["mlp_ratio"],
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model, cfg["block_size"]
