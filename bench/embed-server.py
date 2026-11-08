#!/usr/bin/env python3
"""
A minimal OpenAI-compatible /v1/embeddings server for the zvec-grep comparison, on loopback only.

It serves Qwen3-Embedding-0.6B (mlx-community/Qwen3-Embedding-0.6B-8bit) with MLX on this Mac:
last-token pooling at the tokenizer's end token, L2-normalised, the way the model is meant to be
used. No key, no network: it binds 127.0.0.1 and loads the model from the local Hugging Face cache
(HF_HUB_OFFLINE=1). bench/zvec-client.mjs's proxy sits in front of it and adds Qwen3's query
instruction to query embeddings.

Needs a Python with mlx-lm (for example a virtualenv with `pip install mlx-lm`):

  python3 bench/embed-server.py [--port 47812] [--repo mlx-community/Qwen3-Embedding-0.6B-8bit]
"""
import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=47812)
ap.add_argument("--repo", default="mlx-community/Qwen3-Embedding-0.6B-8bit")
ap.add_argument("--revision", default="407ad2329cd30702720aafe83f74a1ba30fdfbca")
ap.add_argument("--max-tokens", type=int, default=8192)
args = ap.parse_args()

import mlx.core as mx  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
from mlx_lm import load  # noqa: E402

from huggingface_hub import constants  # noqa: E402

cached = os.path.join(constants.HF_HUB_CACHE, "models--" + args.repo.replace("/", "--"), "snapshots", args.revision)
# the weights and tokenizer are enough: a snapshot without the README is fine
model, tok = load(cached if os.path.exists(os.path.join(cached, "model.safetensors")) else snapshot_download(args.repo, revision=args.revision))
probe = list(tok.encode("a"))
special = set(getattr(tok, "all_special_ids", None) or []) | {tok.eos_token_id}
END = probe[-1] if probe and probe[-1] in special else tok.eos_token_id
PAD = tok.eos_token_id or 0
BATCH_TOKENS, MAX_ROWS = 8192, 64
lock = threading.Lock()


def encode(text):
    ids = list(tok.encode(text))
    if ids and ids[-1] == END:
        ids.pop()
    return ids[: args.max_tokens - 1] + [END]


def embed(texts):
    enc = [encode(t) for t in texts]
    order = sorted(range(len(enc)), key=lambda i: len(enc[i]), reverse=True)
    out = [None] * len(enc)
    start = 0
    while start < len(order):
        width = len(enc[order[start]])
        rows = max(1, min(MAX_ROWS, BATCH_TOKENS // max(width, 1)))
        idx = order[start : start + rows]
        batch = [enc[i] for i in idx]
        hidden = model.model(mx.array([ids + [PAD] * (width - len(ids)) for ids in batch]))
        vecs = hidden[mx.arange(len(batch)), mx.array([len(ids) - 1 for ids in batch])].astype(mx.float32)
        vecs = vecs / (mx.sqrt(mx.sum(vecs * vecs, axis=-1, keepdims=True)) + 1e-8)
        for i, v in zip(idx, vecs.tolist()):
            out[i] = v
        start += rows
        mx.clear_cache()
    return out, sum(len(e) for e in enc)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # no request logging (inputs are code from the benchmark repos)
        pass

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            return self.reply(200, {"object": "list", "data": [{"id": "qwen3-embedding-0.6b", "object": "model"}]})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/embeddings":
            return self.reply(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            with lock:
                vecs, n = embed([str(t) for t in inputs])
            dims = body.get("dimensions")
            if dims and 0 < dims < len(vecs[0]):
                vecs = [[x / (sum(y * y for y in v[:dims]) ** 0.5 + 1e-8) for x in v[:dims]] for v in vecs]
            self.reply(200, {
                "object": "list", "model": body.get("model", "qwen3-embedding-0.6b"),
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)],
                "usage": {"prompt_tokens": n, "total_tokens": n},
            })
        except Exception as e:  # noqa: BLE001
            print(f"embedding failed: {type(e).__name__}", flush=True)  # the type only, never the inputs
            self.reply(500, {"error": type(e).__name__})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"embedding server on http://127.0.0.1:{args.port}/v1/embeddings ({args.repo})", flush=True)
    srv.serve_forever()
