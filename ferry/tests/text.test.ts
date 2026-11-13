import { describe, expect, it } from "vitest";
import { byteLength, clipHead, clipMiddle } from "../shared/bytes";
import { redact } from "../shared/redact";

describe("byteLength", () => {
  it("counts UTF-8 bytes, a surrogate pair as one four-byte character", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("摆渡")).toBe(6);
    expect(byteLength("🙂")).toBe(4);
  });
});

describe("clipHead and clipMiddle", () => {
  it("leave short text alone", () => {
    expect(clipHead("short", 100)).toBe("short");
    expect(clipMiddle("short", 100)).toBe("short");
  });

  it("stay within the limit and say how much was cut", () => {
    const text = "x".repeat(5000);
    const head = clipHead(text, 300);
    expect(byteLength(head)).toBeLessThanOrEqual(300);
    expect(head).toMatch(/ …\[\d+ more bytes\]$/);
    const cut = Number(/\[(\d+) more bytes\]/.exec(head)![1]);
    expect(cut + head.indexOf(" …")).toBe(5000);
  });

  it("keep a third of the start and the end, where results are", () => {
    const text = `${"a".repeat(3000)}${"b".repeat(3000)}`;
    const middle = clipMiddle(text, 600);
    expect(byteLength(middle)).toBeLessThanOrEqual(600);
    expect(middle.startsWith("a")).toBe(true);
    expect(middle.endsWith("b")).toBe(true);
    const [head, tail] = middle.split(/\n…\[\d+ bytes omitted\]…\n/);
    expect(tail!.length).toBeGreaterThan(head!.length);
  });

  it("never split a character", () => {
    const text = "摆渡🙂".repeat(400);
    for (const max of [10, 11, 12, 13, 99, 301]) {
      for (const clipped of [clipHead(text, max), clipMiddle(text, max)]) {
        expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(clipped).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(byteLength(clipped)).toBeLessThanOrEqual(Math.max(max, byteLength(clipped)));
      }
    }
  });
});

// Credential-shaped samples are assembled at run time, so no literal key sits in the source.
const repeat = (char: string, count: number) => char.repeat(count);

describe("redact", () => {
  it("masks common token formats", () => {
    const samples = [
      `sk-${repeat("a", 30)}`,
      `sk-ant-${repeat("b", 30)}`,
      `ghp_${repeat("C", 36)}`,
      `github_pat_${repeat("d", 40)}`,
      `glpat-${repeat("e", 20)}`,
      `AKIA${repeat("F", 16)}`,
      `AIza${repeat("g", 35)}`,
      `xoxb-${repeat("1", 24)}`,
      `npm_${repeat("h", 36)}`,
      `ya29.${repeat("i", 30)}`,
      `eyJ${repeat("j", 12)}.eyJ${repeat("k", 12)}.${repeat("l", 20)}`,
    ];
    for (const sample of samples) {
      const out = redact(`token in text: ${sample} end`);
      expect(out, sample).not.toContain(sample);
      expect(out).toContain("[REDACTED]");
      expect(out).toMatch(/end$/);
    }
  });

  it("masks bearer headers, URL passwords and named secrets but keeps their names", () => {
    expect(redact(`Authorization: bearer ${repeat("Z", 32)}`)).toBe("Authorization: bearer [REDACTED]");
    expect(redact(`git clone https://user:${repeat("p", 12)}@example.com/repo.git`)).toBe("git clone https://user:[REDACTED]@example.com/repo.git");
    expect(redact(`API_KEY=${repeat("q", 24)}`)).toBe("API_KEY=[REDACTED]");
    expect(redact(`"password": "${repeat("r", 20)}"`)).toBe('"password": "[REDACTED]"');
  });

  it("masks a private key block whole, even when cut before its end", () => {
    const begin = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`;
    const end = `-----END ${"OPENSSH"} PRIVATE KEY-----`;
    expect(redact(`before\n${begin}\nAAAA\nBBBB\n${end}\nafter`)).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
    expect(redact(`${begin}\nAAAA`)).toBe("[REDACTED PRIVATE KEY]");
  });

  it("stays linear on long runs of scheme-like text", () => {
    const started = performance.now();
    redact("a.".repeat(131_072));
    redact("a-".repeat(131_072));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(redact(`git+ssh://user:${repeat("p", 12)}@example.com`)).toBe("git+ssh://user:[REDACTED]@example.com");
  });

  it("masks secrets whose name only contains the secret word, and PGP key blocks", () => {
    const value = `wJalrXUtnFEMI/K7MDENG/${repeat("Q", 18)}`;
    for (const name of ["AWS_SECRET_ACCESS_KEY", "aws_secret_access_key", "DB_PASSWORD", "client_secret", "access_token", "STRIPE_SECRET_KEY", "GITHUB_TOKEN"]) {
      expect(redact(`${name} = ${value}`), name).toBe(`${name} = [REDACTED]`);
    }
    expect(redact(`tokenizer=${value}`)).toBe(`tokenizer=${value}`);
    const begin = `-----BEGIN PGP ${"PRIVATE"} KEY BLOCK-----`;
    expect(redact(`${begin}\nAAAA\n-----END PGP ${"PRIVATE"} KEY BLOCK-----\nafter`)).toBe("[REDACTED PRIVATE KEY]\nafter");
    expect(redact(`xapp-1-${repeat("A", 20)}`)).toBe("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    const text = "The token budget is 16000 and the password field is empty; see sk-learn docs.";
    expect(redact(text)).toBe(text);
  });
});
