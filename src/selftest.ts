import assert from "node:assert/strict";
import { type Entry, loadConfig } from "./config.js";
import { compileTriggers, findMatch, normalise } from "./matcher.js";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

function entry(id: string, triggers: string[], extra: Partial<Entry> = {}): Entry {
  return {
    id,
    label: id,
    message: `about ${id}`,
    target: { type: "url", url: "https://example.com" },
    triggers,
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("normalisation");
  await check("strips punctuation and lowercases", () => {
    assert.equal(normalise("How do I get verified?"), "how do i get verified");
  });
  await check("collapses whitespace and strips emoji", () => {
    assert.equal(normalise("  rules   now 🎉 "), "rules now");
  });

  console.log("\nphrase matching");
  {
    const triggers = compileTriggers([entry("verify", ["how do i get verified", "verification"])]);

    await check("matches a differently punctuated question", () => {
      assert.equal(findMatch(triggers, "How do I get verified??")?.entry.id, "verify");
    });
    await check("matches the exact phrase", () => {
      assert.equal(findMatch(triggers, "verification")?.entry.id, "verify");
    });
    await check("does not match a related but different word", () => {
      const t = compileTriggers([entry("v", ["verification"])]);
      assert.equal(findMatch(t, "how do i get verified"), null);
    });
    await check("word boundary: 'rules' matches inside a sentence", () => {
      const t = compileTriggers([entry("rules", ["rules"])]);
      assert.equal(findMatch(t, "where are the safety rules")?.entry.id, "rules");
    });
    await check("word boundary: 'rules' does not match 'safetyrules'", () => {
      const t = compileTriggers([entry("rules", ["rules"])]);
      assert.equal(findMatch(t, "safetyrules"), null);
    });
    await check("is case insensitive", () => {
      assert.equal(findMatch(triggers, "VERIFICATION")?.entry.id, "verify");
    });
    await check("'verify' does not match 'verified'", () => {
      const t = compileTriggers([entry("v", ["verify"])]);
      assert.equal(findMatch(t, "your account is verified"), null);
    });
  }

  console.log("\npriority");
  {
    const triggers = compileTriggers([
      entry("short", ["verify"]),
      entry("long", ["how do i get verified"]),
    ]);

    await check("longest trigger wins regardless of config order", () => {
      assert.equal(findMatch(triggers, "how do I get verified")?.entry.id, "long");
    });
    await check("short trigger still fires on its own", () => {
      assert.equal(findMatch(triggers, "can you verify me")?.entry.id, "short");
    });
    await check("ties resolve to the first entry in config order", () => {
      const tied = compileTriggers([entry("first", ["alpha"]), entry("second", ["alpha"])]);
      assert.equal(findMatch(tied, "alpha")?.entry.id, "first");
    });
  }

  console.log("\nregex triggers");
  {
    const triggers = compileTriggers([entry("cpp", ["/c\\+\\+/i"])]);

    await check("matches literal symbols the normaliser would strip", () => {
      assert.equal(findMatch(triggers, "why does C++ crash?")?.entry.id, "cpp");
    });
    await check("matches against the raw message", () => {
      assert.equal(findMatch(triggers, "C++17 support?")?.entry.id, "cpp");
    });
  }

  console.log("\nconfig safety");
  await check("rejects a trigger that collapses to a lone short token", () => {
    assert.throws(() => compileTriggers([entry("lang", ["C#"])]), /regex trigger/);
  });
  await check("rejects an empty trigger list at compile time", () => {
    assert.throws(() => compileTriggers([entry("empty", ["   "])]), /empty/);
  });

  console.log("\nedge cases");
  {
    const triggers = compileTriggers([entry("rules", ["rules"])]);

    await check("returns null for an empty message", () => {
      assert.equal(findMatch(triggers, "   "), null);
    });
    await check("returns null when nothing matches", () => {
      assert.equal(findMatch(triggers, "hello everyone"), null);
    });
    await check("handles a message that is only punctuation", () => {
      assert.equal(findMatch(triggers, "??? !!!"), null);
    });
  }

  console.log("\nconfig file");
  {
    let entries = 0;
    await check("config/faq.json loads and validates", async () => {
      const config = await loadConfig("config/faq.json");
      entries = config.entries.length;
      assert.ok(entries > 0, "expected at least one entry");
    });
    if (entries > 0) {
      await check("every configured trigger compiles", async () => {
        const config = await loadConfig("config/faq.json");
        const compiled = compileTriggers(config.entries);
        assert.ok(compiled.length > 0);
      });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("selftest crashed:", error);
  process.exitCode = 1;
});
