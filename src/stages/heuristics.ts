interface HeuristicRule {
  pattern: RegExp;
  confidence: number;
}

/**
 * v1.2.0 — pure-vocabulary regex rules removed. The v1.1 binary classifier
 * already handles those patterns at higher precision; the regex layer was
 * duplicating work and producing false positives (e.g. "Show me how to write
 * a system prompt for my own chatbot" was flagged by the old
 * system_prompt_leak regex). Only rules left in this tuple are structural —
 * they detect attacks that don't survive tokenization (chat-template control
 * tokens) or use formatting cues the model wasn't trained on (fake
 * end-of-prompt delimiters).
 */
const DEFAULT_RULES: readonly HeuristicRule[] = Object.freeze([
  // Chat template control tokens injected as user input. Case-SENSITIVE.
  {
    pattern: /<\|(im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?(INST|SYS)\]|<<SYS>>/,
    confidence: 0.97,
  },
  // Fake delimiters claiming the system prompt has ended.
  {
    pattern:
      /-{3,}\s*end\s+of\s+(prompt|instructions?|system)\s*-{3,}|###\s*end\s+of\s+(prompt|instructions?|system)\s*###/i,
    confidence: 0.9,
  },
]);

// ZWSP, ZWNJ, ZWJ, word joiner, BOM, Mongolian vowel separator. Built from a
// string of escapes rather than a regex literal so the source stays pure ASCII
// (these characters are invisible in an editor) and so the class isn't read as
// a joined grapheme sequence.
// Matching ZWJ as a standalone character is the point of this rule: we count
// the joiners themselves, not the graphemes they compose.
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_RE = new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\u180E]", "g");

/**
 * Base64 payloads worth flagging are long, mixed-case, contain digits, and
 * end with padding `=`. These three constraints cut math/identifier strings.
 *
 * Note the trailing `\b`: because `=` is a non-word character, this only
 * matches when a word character immediately follows the padding, so a payload
 * at end-of-string does NOT match. That is the Python behaviour and is
 * reproduced deliberately — the golden fixture pins it.
 */
const BASE64_PAYLOAD_RE =
  /\b(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{60,}={1,2}\b/;

/**
 * Spaced-letter obfuscation: at least 8 single letters separated by spaces.
 * 5 was too short and matched legitimate single-letter spelling-out in math
 * and language problems.
 */
const SPACED_LETTERS_RE = /(?:\b[A-Za-z]\s){8,}[A-Za-z]\b/;

function structuralScore(text: string): number {
  const zeroWidth = text.match(ZERO_WIDTH_RE)?.length ?? 0;
  if (zeroWidth >= 3) return 0.96;
  if (SPACED_LETTERS_RE.test(text)) return 0.8;
  if (BASE64_PAYLOAD_RE.test(text)) return 0.55;
  return 0.0;
}

export class HeuristicsStage {
  constructor(private readonly rules: readonly HeuristicRule[] = DEFAULT_RULES) {}

  /** Return the highest-confidence match score (0.0 if no match). */
  score(text: string): number {
    if (!text) return 0.0;
    let best = 0.0;
    for (const rule of this.rules) {
      // TODO(R6): stateful global regexes — prefer matchAll or non-global patterns
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text) && rule.confidence > best) best = rule.confidence;
    }
    return Math.max(best, structuralScore(text));
  }
}
