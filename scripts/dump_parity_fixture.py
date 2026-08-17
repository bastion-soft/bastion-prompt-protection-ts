"""Golden-fixture generator: run the real Python Guard over the shared corpus and
dump its verdicts. This is the oracle the TypeScript port is verified against —
it pins tokenizer + ONNX + temperature scaling together, the part of the Python
package that has no test coverage of its own.

Emits both the full-pipeline result and the isolated heuristics score, so the TS
suite can localise any divergence to a specific stage.
"""

import json
import pathlib

from bastion_prompt_protection import Guard, GuardConfig, __version__
from bastion_prompt_protection.stages.heuristics import HeuristicsStage

HERE = pathlib.Path(__file__).parent

corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))

guard = Guard()
heur = HeuristicsStage()

# Force the model to load so model_version is populated and recorded.
guard.protect("warmup")

cfg = GuardConfig()
meta = {
    "sdk_version": __version__,
    "model_id": cfg.model_id("binary"),
    "model_version": guard.model_version,
    "preset": cfg.preset.value,
    "thresholds": {
        "attack_above": cfg.thresholds.attack_above,
        "heuristic_short_circuit": cfg.thresholds.heuristic_short_circuit,
    },
    "max_input_chars": cfg.max_input_chars,
}
print(json.dumps(meta, indent=2))

cases = []
for c in corpus:
    text = c["text"]
    result = guard.protect(text)
    # Heuristics sees the same char-truncated text the guard feeds it.
    truncated = (text or "")[: cfg.max_input_chars]
    cases.append(
        {
            "id": c["id"],
            "group": c["group"],
            "text": text,
            "heuristic_score": round(heur.run(truncated), 6),
            "risk": result.risk,
            "label": result.label,
            "stage_reached": result.stage_reached,
        }
    )

payload = {"schema_version": 1, "meta": meta, "cases": cases}
out = HERE / "parity.json"
out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

n_attack = sum(1 for c in cases if c["label"] == "attack")
n_heur = sum(1 for c in cases if c["stage_reached"] == "heuristics")
print(f"\nwrote {len(cases)} cases to {out}")
print(f"  label=attack        : {n_attack}")
print(f"  label=safe          : {len(cases) - n_attack}")
print(f"  stage=heuristics    : {n_heur}")
print(f"  stage=binary        : {len(cases) - n_heur}")
