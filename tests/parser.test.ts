import { beforeAll, describe, expect, it, vi } from "vitest";
import { fallbackChunks, MAX_CHUNK_LINES, parseFile, parseMarkdown, preloadGrammars } from "@/lib/indexing/parser";

const MODEL_TS = `export interface Order {
  id: string;
  state: string;
  expiresAt: Date | null;
}

export class OrderRepository {
  private static orders: Order[] = [];

  static findById(id: string): Order | undefined {
    return OrderRepository.orders.find((o) => o.id === id);
  }

  static find(filter: { state: string }): Order[] {
    return OrderRepository.orders.filter((o) => o.state === filter.state);
  }

  static save(order: Order): void {
    OrderRepository.orders.push(order);
  }
}
`;

const SERVICE_TS = `import { Order } from './model';
import { notify } from '../notify/service';

export class OrderService {
  cancelOrder(id: string): boolean {
    const order = Order.findById(id);
    if (order.isExpired()) {
      notify.sendExpiring(id);
    }
    order.state = 'cancelled';
    return true;
  }

  listPending(): string[] {
    return Order.find({ state: 'pending' }).map((o) => o.id);
  }
}
`;

const SERVICE_PY = `import smtplib


class NotificationService:
    def __init__(self, smtp_host: str):
        self.smtp_host = smtp_host

    def send_expiring(self, order_id: str) -> None:
        print(f"notifying about expiring order {order_id}")

    def send_cancelled(self, order_id: str) -> None:
        print(f"notifying about cancelled order {order_id}")


def notify_expired_orders(service: NotificationService, ids: list[str]) -> None:
    for order_id in ids:
        service.send_expiring(order_id)
`;

const FLOWS_MD = `# Order flows

## Expiry

When a pickup reservation expires, \`OrderService.cancelOrder\` is invoked
through the expiry worker, and \`NotificationService.send_expiring\` notifies
the customer.

## Cancellation

Cancellations set the order state to \`cancelled\` and send a notification.
`;

function symbol(parsed: ReturnType<typeof parseFile>, qualifiedName: string) {
  return parsed.symbols.find((s) => s.qualifiedName === qualifiedName);
}

describe("parser", () => {
  beforeAll(async () => {
    await preloadGrammars();
  });

  describe("typescript", () => {
    it("extracts interface, class and method symbols with kinds and line spans", () => {
      const parsed = parseFile("src/orders/model.ts", MODEL_TS);
      expect(parsed.language).toBe("typescript");
      expect(parsed.error).toBeNull();

      const order = symbol(parsed, "Order");
      expect(order).not.toBeNull();
      expect(order!.kind).toBe("interface");
      expect(order!.name).toBe("Order");
      expect(order!.parentName).toBeNull();
      expect(order!.startLine).toBe(1);
      expect(order!.endLine).toBe(5);

      const repo = symbol(parsed, "OrderRepository");
      expect(repo!.kind).toBe("class");
      expect(repo!.startLine).toBe(7);
      expect(repo!.endLine).toBe(21);

      const findById = symbol(parsed, "OrderRepository.findById");
      expect(findById!.kind).toBe("method");
      expect(findById!.parentName).toBe("OrderRepository");
      expect(findById!.startLine).toBe(10);
      expect(findById!.endLine).toBe(12);
      expect(findById!.calls).toContain("OrderRepository.orders.find");
    });

    it("skips class fields as constants but keeps module-scope declarations", () => {
      const parsed = parseFile("src/orders/model.ts", MODEL_TS);
      const names = parsed.symbols.map((s) => s.qualifiedName);
      expect(names).toContain("Order");
      expect(names).not.toContain("OrderRepository.orders");
    });

    it("emits a module file symbol carrying file-level imports", () => {
      const parsed = parseFile("src/orders/service.ts", SERVICE_TS);
      const mod = parsed.symbols.find((s) => s.kind === "module");
      expect(mod).not.toBeNull();
      expect(mod!.name).toBe("service.ts");
      expect(mod!.qualifiedName).toBe("service.ts");
      expect(mod!.imports).toEqual(["../notify/service", "./model"]);
      expect(mod!.calls).toEqual([]);
    });

    it("records calls per method", () => {
      const parsed = parseFile("src/orders/service.ts", SERVICE_TS);
      const cancel = symbol(parsed, "OrderService.cancelOrder");
      expect(cancel!.calls).toContain("Order.findById");
      expect(cancel!.calls).toContain("notify.sendExpiring");
      expect(cancel!.calls).toContain("order.isExpired");

      const pending = symbol(parsed, "OrderService.listPending");
      expect(pending!.calls).toContain("Order.find");
    });

    it("chunks declarations and gap blocks separately", () => {
      const parsed = parseFile("src/orders/service.ts", SERVICE_TS);
      const cancelChunk = parsed.chunks.find((c) => c.symbolName === "OrderService.cancelOrder");
      expect(cancelChunk).not.toBeNull();
      expect(cancelChunk!.kind).toBe("method");
      expect(cancelChunk!.chunkType).toBe("code");
      expect(cancelChunk!.content).toContain("Order.findById");

      const importGap = parsed.chunks.find((c) => c.symbolName === null);
      expect(importGap).not.toBeNull();
      expect(importGap!.kind).toBe("module");
      expect(importGap!.content).toContain("import { Order } from './model';");
    });
  });

  describe("python", () => {
    it("extracts classes, methods and module-level imports when the grammar loads", () => {
      const parsed = parseFile("src/notify/service.py", SERVICE_PY);
      expect(parsed.language).toBe("python");
      expect(parsed.error).toBeNull();
      const names = parsed.symbols.map((s) => s.qualifiedName);
      expect(names).toContain("NotificationService");
      expect(names).toContain("NotificationService.send_expiring");
      expect(parsed.symbols[0].kind).toBe("module");
      expect(parsed.chunks.length).toBeGreaterThan(0);
      expect(parsed.chunks.every((c) => c.chunkType === "code")).toBe(true);
      expect(parsed.chunks.map((c) => c.content).join("\n")).toContain("class NotificationService");
    });

    // The fallback arm is only reachable when the grammar cache has no entry
    // for the file's language, which after `preloadGrammars()` above it never
    // does — the previous version of this test guarded its assertions with
    // `if (parsed.error)`, so on any machine where the grammars load (all of
    // them) the body was skipped and the test asserted nothing.
    //
    // The condition is manufactured instead: a fresh module registry gives a
    // fresh grammar cache, and stubbing every `loadGrammar` to return undefined
    // is the "a grammar could not be resolved" case that `preloadGrammars`
    // reports rather than throws. Everything after that is the real
    // parseFile, the real language registry and the real fallback chunker.
    it("falls back to block chunking when the grammar cannot be resolved", async () => {
      vi.resetModules();
      vi.doMock("@/lib/indexing/languages", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/lib/indexing/languages")>();
        const broken = Object.fromEntries(
          Object.entries(actual.LANGUAGES).map(([id, def]) => [
            id,
            { ...def, loadGrammar: () => undefined },
          ]),
        );
        return { ...actual, LANGUAGES: broken };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fresh = await import("@/lib/indexing/parser");
        await fresh.preloadGrammars();

        const parsed = fresh.parseFile("src/notify/service.py", SERVICE_PY);
        // The reason is recorded, not thrown: a broken grammar must not abort
        // the indexing job it was going to contribute to.
        expect(parsed.error).toBe('No tree-sitter grammar for language "python"');
        expect(parsed.symbols).toEqual([]);
        // Byte-for-byte what the fallback chunker produces for the same input,
        // so this pins the degraded output and not merely its length.
        expect(parsed.chunks).toEqual(fresh.fallbackChunks(SERVICE_PY, "code"));
        expect(parsed.chunks.map((c) => c.content).join("\n")).toContain(
          "class NotificationService",
        );
        // And the languages are reported as unavailable rather than hidden: the
        // startup warning is the operator's only clue, so its absence is a
        // regression too.
        expect(fresh.unavailableGrammars()).toContain("python");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/grammar\(s\) unavailable/);
      } finally {
        warn.mockRestore();
        vi.doUnmock("@/lib/indexing/languages");
        vi.resetModules();
      }
    });
  });

  describe("markdown", () => {
    it("splits documentation on headings into section symbols and chunks", () => {
      const parsed = parseMarkdown("docs/FLOWS.md", FLOWS_MD);
      expect(parsed.language).toBe("markdown");

      const names = parsed.symbols.map((s) => s.qualifiedName);
      expect(names).toEqual(["Order flows", "Expiry", "Cancellation"]);
      for (const s of parsed.symbols) expect(s.kind).toBe("section");

      expect(parsed.chunks).toHaveLength(3);
      for (const c of parsed.chunks) expect(c.chunkType).toBe("documentation");
      expect(parsed.chunks[0].symbolName).toBe("docs:Order flows");
      expect(parsed.chunks[0].content).toContain("# Order flows");
      expect(parsed.chunks[1].symbolName).toBe("docs:Expiry");
      expect(parsed.chunks[1].content).toContain("OrderService.cancelOrder");
    });
  });

  describe("fallbackChunks", () => {
    it("line-splits long files at MAX_CHUNK_LINES", () => {
      const lines = Array.from({ length: MAX_CHUNK_LINES * 2 + 7 }, (_, i) => `line ${i + 1}`);
      const chunks = fallbackChunks(lines.join("\n"), "code");
      expect(chunks).toHaveLength(3);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(MAX_CHUNK_LINES);
      expect(chunks[0].content).toContain("line 1");
      expect(chunks[1].startLine).toBe(MAX_CHUNK_LINES + 1);
      expect(chunks[2].startLine).toBe(MAX_CHUNK_LINES * 2 + 1);
      for (const c of chunks) {
        expect(c.symbolName).toBeNull();
        expect(c.kind).toBe("module");
      }
    });

    it("prefers a blank-line break near the hard limit", () => {
      const lines = Array.from({ length: MAX_CHUNK_LINES * 2 }, (_, i) => (i === MAX_CHUNK_LINES + 2 ? "" : `l${i}`));
      const chunks = fallbackChunks(lines.join("\n"), "code");
      expect(chunks).toHaveLength(2);
      expect(chunks[0].endLine).toBeLessThanOrEqual(MAX_CHUNK_LINES);
      expect(chunks[0].endLine).toBeGreaterThan(MAX_CHUNK_LINES - 40);
    });

    it("maps the category onto the chunk type and returns nothing for empty input", () => {
      expect(fallbackChunks("", "code")).toEqual([]);
      const docs = fallbackChunks("hello\nworld\n", "documentation");
      expect(docs).toHaveLength(1);
      expect(docs[0].chunkType).toBe("documentation");
      const cfg = fallbackChunks("a: 1\n", "configuration");
      expect(cfg[0].chunkType).toBe("configuration");
    });
  });

  describe("declaration chunking", () => {
    // Regression: the chunk cursor was assigned `d.endLine` for every
    // declaration, and declNodes contains *nested* declarations. A class
    // spanning lines 9-61 was followed by its methods at 21, 31 and 41, so the
    // cursor rewound from 61 to 21 and each later method looked like it was
    // preceded by an uncovered gap — emitting block chunks for lines already
    // inside the class chunk. Every duplicate chunk is a duplicate embedding
    // call, and for ordinary class-per-file code it was a 2-4x cost.
    const CLASS_WITH_METHODS = [
      ...Array.from({ length: 8 }, (_, i) => `// filler ${i + 1}`),
      "class OrderService {",
      ...Array.from({ length: 11 }, (_, i) => `  // body ${i + 1}`),
      "  cancelOrder() { return 1; }",
      ...Array.from({ length: 9 }, (_, i) => `  // body ${i + 12}`),
      "  listPending() { return 2; }",
      ...Array.from({ length: 9 }, (_, i) => `  // body ${i + 22}`),
      "  total() { return 3; }",
      ...Array.from({ length: 19 }, (_, i) => `  // tail ${i + 1}`),
      "}",
      "export const after = 1;",
    ].join("\n");

    it("emits no gap-block chunk that overlaps a declaration chunk", () => {
      const parsed = parseFile("src/service.ts", CLASS_WITH_METHODS);
      const total = CLASS_WITH_METHODS.split("\n").length;

      // Coverage must be exact: every line in at most one *gap* chunk, and no
      // gap chunk may sit inside a declaration's range.
      const declarationRanges = parsed.chunks
        .filter((c) => c.symbolName !== null)
        .map((c) => [c.startLine, c.endLine] as const);
      const gaps = parsed.chunks.filter((c) => c.symbolName === null);

      for (const gap of gaps) {
        for (const [start, end] of declarationRanges) {
          const overlaps = gap.startLine <= end && gap.endLine >= start;
          expect(
            overlaps,
            `gap chunk ${gap.startLine}-${gap.endLine} overlaps declaration ${start}-${end}`,
          ).toBe(false);
        }
      }

      // And the union of all chunks is the whole file, with no line chunked
      // by two different gap blocks.
      const gapCoverage = new Map<number, number>();
      for (const gap of gaps) {
        for (let line = gap.startLine; line <= gap.endLine; line++) {
          gapCoverage.set(line, (gapCoverage.get(line) ?? 0) + 1);
        }
      }
      for (const [line, count] of gapCoverage) {
        expect(count, `line ${line} covered by ${count} gap chunks`).toBe(1);
      }
      expect(Math.max(...gapCoverage.keys())).toBeLessThanOrEqual(total);
    });

    it("does not inflate the chunk count for nested declarations", () => {
      const parsed = parseFile("src/service.ts", CLASS_WITH_METHODS);
      // 1 gap (leading filler) + class + 3 methods + the trailing exported
      // constant, which is a declaration in its own right. It used to be
      // counted as a gap: the module-scope test looked only at the immediate
      // parent, and an exported constant's parent is the `export_statement`
      // wrapping it, not the `program` node.
      const gaps = parsed.chunks.filter((c) => c.symbolName === null).length;
      const declarations = parsed.chunks.filter((c) => c.symbolName !== null).length;
      expect(declarations).toBe(5);
      expect(gaps).toBe(1);
    });
  });

  describe("qualified names", () => {
    // Regression: the ancestor map stored each declaration's *unqualified*
    // name, and the level below composed its qualified name from that entry.
    // A method `b` in class `A` registered as "b", so anything nested inside
    // it came out as "b.c" instead of "A.b.c" — every symbol three or more
    // levels deep was misnamed, which silently broke find_symbol, references
    // and dependency lookups for deeply nested code.
    const NESTED = `class Outer {
  static inner(): void {}

  method(): void {
    class DeeplyNested {
      run(): void {}
    }
  }
}

namespace NS {
  export class Member {
    call(): void {}
  }
}
`;

    it("keeps the full chain for deeply nested declarations", () => {
      const parsed = parseFile("src/nested.ts", NESTED);
      const names = parsed.symbols.map((s) => s.qualifiedName);
      for (const expected of [
        "Outer",
        "Outer.method",
        "Outer.method.DeeplyNested",
        "Outer.method.DeeplyNested.run",
      ]) {
        expect(names, expected).toContain(expected);
      }
    });

    it("records the full qualified name as the parent, not the bare name", () => {
      const parsed = parseFile("src/nested.ts", NESTED);
      const run = parsed.symbols.find((s) => s.name === "run");
      expect(run?.parentName).toBe("Outer.method.DeeplyNested");
    });
  });
});

describe("heritage", () => {
  // Regression: extractHeritage took the clause's whole text and stripped the
  // keywords with a global replace, so `class Foo extends Bar, Baz` produced
  // the single string "Bar Baz", and `implements` was folded into `extends`.
  // It also walked every descendant, so a class nested inside another
  // contributed its superclass to the outer class.
  it("splits a multi-parent extends list into separate entries", () => {
    const parsed = parseFile(
      "src/a.ts",
      "abstract class Base {}\nclass Mixin {}\nclass Repo extends Base, Mixin {}\n",
    );
    const repo = parsed.symbols.find((s) => s.qualifiedName === "Repo");
    expect(repo?.extends).toEqual(["Base", "Mixin"]);
    expect(repo?.implements).toEqual([]);
  });

  it("separates extends from implements", () => {
    const parsed = parseFile(
      "src/b.ts",
      "interface Auditable {}\ninterface Serializable {}\nabstract class Base {}\n" +
        "class Service extends Base implements Auditable, Serializable {}\n",
    );
    const service = parsed.symbols.find((s) => s.qualifiedName === "Service");
    expect(service?.extends).toEqual(["Base"]);
    expect(service?.implements).toEqual(["Auditable", "Serializable"]);
  });

  it("strips generic arguments from the base name", () => {
    const parsed = parseFile("src/c.ts", "class Repo extends BaseRepository<Order> {}\n");
    const repo = parsed.symbols.find((s) => s.qualifiedName === "Repo");
    expect(repo?.extends).toEqual(["BaseRepository"]);
  });

  it("does not attribute a nested class's superclass to the outer class", () => {
    const parsed = parseFile(
      "src/d.ts",
      "class Inner {}\nclass Outer {\n  m() {\n    class Nested extends Inner {}\n    return Nested;\n  }\n}\n",
    );
    const outer = parsed.symbols.find((s) => s.qualifiedName === "Outer");
    const nested = parsed.symbols.find((s) => s.qualifiedName === "Outer.m.Nested");
    expect(nested?.extends).toEqual(["Inner"]);
    expect(outer?.extends).toEqual([]);
  });

  // The TypeScript grammar nests an `extends_clause` inside `class_heritage`
  // with identical text. Collecting both made the second copy parse as the
  // C# colon form and pushed the second base class into `implements`.
  it("does not collect a nested duplicate clause", () => {
    const parsed = parseFile("src/e.ts", "class Only extends A, B {}\n");
    const only = parsed.symbols.find((s) => s.qualifiedName === "Only");
    expect(only?.extends).toEqual(["A", "B"]);
    expect(only?.implements).toEqual([]);
  });
});

describe("heritage across grammars", () => {
  // The clause-node set once named `class_interface_clause` for Java, which
  // that grammar does not emit, and omitted the interface-inheritance nodes
  // for both Java and TypeScript. Nothing failed: the clause was simply not in
  // the set, so those relationships were recorded as absent. Every case here
  // was verified by running the project's own installed grammars.
  beforeAll(async () => {
    await preloadGrammars();
  });

  const heritage = (path: string, source: string) => {
    const found = parseFile(path, source).symbols[0];
    return { extends: found?.extends ?? [], implements: found?.implements ?? [] };
  };

  it("extracts a Java class's implements list", () => {
    const h = heritage("A.java", "class A extends B implements C, D {}\n");
    expect(h.extends).toEqual(["B"]);
    expect(h.implements).toEqual(["C", "D"]);
  });

  it("extracts a TypeScript interface's extends list", () => {
    expect(heritage("A.ts", "interface A extends B, C {}\n").extends).toEqual(["B", "C"]);
  });

  it("extracts a Java interface's extends list", () => {
    expect(heritage("A.java", "interface A extends B, C {}\n").extends).toEqual(["B", "C"]);
  });

  it("still splits a TypeScript class header on its keyword", () => {
    const h = heritage("A.ts", "class A extends B implements C {}\n");
    expect(h.extends).toEqual(["B"]);
    expect(h.implements).toEqual(["C"]);
  });

  it("still reads a C# base list positionally", () => {
    const h = heritage("A.cs", "class A : B, IFoo {}\n");
    expect(h.extends).toEqual(["B"]);
    expect(h.implements).toEqual(["IFoo"]);
  });

  // Python states inheritance as base-class arguments in the class header, not
  // a heritage clause, so there is genuinely nothing to extract.
  it("reports nothing for Python, which has no heritage clause", () => {
    expect(heritage("A.py", "class A(B):\n  pass\n")).toEqual({ extends: [], implements: [] });
  });
});

describe("markdown chunk bounds", () => {
  // A markdown file with one enormous section — an API dump, a generated
  // table, a pasted log — was flushed as a SINGLE uncapped chunk, which was
  // then embedded whole, stored in the Qdrant payload verbatim, and served in
  // full by get_file. The same defect had just been fixed for declaration
  // chunks; this was the identical bug one function away.
  it("splits a long section into bounded chunks that reassemble exactly", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const source = `# Title\n\n${body}\n`;
    const parsed = parseMarkdown("docs/BIG.md", source).chunks;

    expect(parsed.length).toBeGreaterThan(1);
    for (const chunk of parsed) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(MAX_CHUNK_LINES);
    }
    // The parts are contiguous and together cover the section exactly, so a
    // caller reading a range gets the same bytes back.
    const joined = parsed
      .slice()
      .sort((a, b) => a.startLine - b.startLine)
      .map((c) => source.split("\n").slice(c.startLine - 1, c.endLine).join("\n"))
      .join("\n");
    // The first chunk legitimately starts at the heading, so the parts
    // together reconstruct the WHOLE file rather than just the body.
    expect(joined.replace(/\s+/g, " ").trim()).toBe(
      source.replace(/\s+/g, " ").trim(),
    );
  });

  it("leaves a short section as a single chunk", () => {
    expect(parseMarkdown("docs/small.md", "# Title\n\none\ntwo\n").chunks).toHaveLength(1);
  });
});
