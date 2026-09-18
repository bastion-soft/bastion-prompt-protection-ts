# Fixture generators

These scripts run against the **Python** package (`bastion-prompt-protection`) and
regenerate the golden fixtures the TypeScript test suite verifies itself against.
They are not part of the published npm package and are not needed to build or use
it — they exist so the parity fixtures are reproducible rather than magic.

Run them from a checkout of the Python repo with its virtualenv active:

```bash
pip install bastion-prompt-protection
python build_corpus.py          # -> corpus.json          (113 shared cases)
python dump_parity_fixture.py   # -> parity.json          -> test/fixtures/parity.json
python canonical_cases.py       # -> canonical_cases.json -> test/fixtures/canonical-json.json
```

## What each fixture pins

| Fixture                             | Pins                                                                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/fixtures/parity.json`         | End-to-end verdicts (`risk`, `label`, `stage_reached`) plus the isolated `heuristic_score`, so a divergence can be localised to a stage. This is the only oracle for the ONNX path — the Python package has no unit test covering the classifier stage. |
| `test/fixtures/canonical-json.json` | Byte-exact output of Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. License signatures are computed over these bytes, so any drift here silently invalidates every signature.                                    |

## Regenerating after a model change

`parity.json` records the `model_version` it was generated from, and the parity
suite asserts the loaded model matches. When the model is retrained and the HF
snapshot SHA changes, re-run `dump_parity_fixture.py` and commit the new fixture
in the same change.
