#!/usr/bin/env python3
"""
MLX Embedder Server — stdin/stdout JSON Lines protocol.

Input:  {"texts": ["text1", "text2", ...]} (batch, up to 32)
Output: {"embeddings": [[...], [...]]} or {"error": "message"}

Prints "READY\n" to stdout once the model is loaded.
Logs to stderr only (stdout is reserved for the JSON protocol).

The model id is passed by the Node side as argv[1] (default below). Whatever id is
loaded here is also what the Node side stamps into the index meta sidecar, so the
{provider, model, dim} always reflects the exact model that produced the vectors.
Override it with --mlx-embed-model / INDEXER_MLX_EMBED_MODEL on the graph-indexer side.
"""
import sys, json
import numpy as np

DEFAULT_MODEL_ID = "mlx-community/all-MiniLM-L6-v2-4bit"
MODEL_ID = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].strip() else DEFAULT_MODEL_ID


def load_model():
    try:
        from mlx_embeddings.utils import load
        model, tokenizer = load(MODEL_ID)
        return model, tokenizer
    except ImportError as e:
        print(json.dumps({"error": f"mlx_embeddings not installed: {e}"}), flush=True)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"model load failed: {e}"}), flush=True)
        sys.exit(1)


def embed_batch(model, tokenizer, texts):
    # Empty / falsy texts → "" so the tokenizer never sees None.
    texts = [t[:8000] if t else "" for t in texts]
    inputs = tokenizer.batch_encode_plus(
        texts, return_tensors="mlx",
        padding=True, truncation=True, max_length=512
    )
    out = model(inputs["input_ids"], attention_mask=inputs.get("attention_mask"))
    vecs = out.text_embeds  # already mean-pooled and L2-normalized
    return np.asarray(vecs, dtype=np.float32).tolist()


model, tokenizer = load_model()
print("READY", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        texts = req.get("texts", [])
        embeddings = embed_batch(model, tokenizer, texts)
        print(json.dumps({"embeddings": embeddings}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
