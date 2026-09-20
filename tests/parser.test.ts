import { beforeAll, describe, expect, it } from "vitest";
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

    it("falls back to chunking without symbols when the grammar is unavailable", () => {
      // The JS/python prebuilt grammars do not load under tree-sitter 0.25.1
      // in some environments; the parser must degrade to block chunking
      // instead of crashing an index job. This test documents the fallback.
      const parsed = parseFile("src/notify/service.py", SERVICE_PY);
      if (parsed.error) {
        expect(parsed.symbols).toEqual([]);
        expect(parsed.chunks.length).toBeGreaterThan(0);
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
});