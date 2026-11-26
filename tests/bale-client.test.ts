import { describe, expect, test } from "bun:test";
import { BaleApiError, BaleClient, parseUpdate, type BaleFetcher } from "../src/bot/bale/client.ts";

describe("Bale update parsing", () => {
  test("parses private text and selects the largest photo", () => {
    expect(parseUpdate({ update_id: 8, message: { message_id: 4,
      from: { id: 12 }, chat: { id: 12, type: "private" }, text: "سلام",
      photo: [{ file_id: "small", file_size: 10 }, { file_id: "large", file_size: 20 }],
    } })).toEqual({ update_id: 8, message: { message_id: 4, from: { id: 12 },
      chat: { id: 12, type: "private" }, text: "سلام",
      media: { kind: "photo", fileId: "large", sizeBytes: 20 } } });
  });

  test("parses callback message information used for edits", () => {
    expect(parseUpdate({ update_id: 9, callback_query: { id: "cb", from: { id: 12 }, data: "token",
      message: { message_id: 77, chat: { id: 12, type: "private" } } } }))
      .toEqual({ update_id: 9, callback_query: { id: "cb", from: { id: 12 }, data: "token",
        message: { message_id: 77, chat: { id: 12, type: "private" } } } });
  });

  test("rejects unsafe identifiers and malformed media", () => {
    expect(() => parseUpdate({ update_id: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => parseUpdate({ update_id: 1, message: { message_id: 1,
      chat: { id: 0, type: "private" }, document: { file_name: "missing-id" } } })).toThrow();
  });
});

describe("Bale API client", () => {
  test("sends inline buttons and truncates oversized messages", async () => {
    let requestBody: unknown;
    const fetcher: BaleFetcher = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, result: { message_id: 42 } });
    };
    const client = new BaleClient("token", fetcher);
    await expect(client.sendText("123", "x".repeat(4100), [[{
      text: "تأیید", callback_data: "opaque", style: "success",
    }]])).resolves.toBe("42");
    const body = requestBody as Record<string, unknown>;
    expect(String(body.text).length).toBeLessThanOrEqual(4000);
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{
      text: "تأیید", callback_data: "opaque", style: "success",
    }]] });
  });

  test("surfaces retry_after from Bale errors", async () => {
    const client = new BaleClient("token", async () => Response.json({ ok: false,
      error_code: 429, parameters: { retry_after: 7 } }, { status: 429 }));
    const error = await client.sendText("1", "hello").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BaleApiError);
    expect(error).toMatchObject({ code: 429, retryAfter: 7 });
  });

  test("does not acknowledge callbacks unsupported by old clients", async () => {
    let calls = 0;
    const client = new BaleClient("token", async () => {
      calls += 1;
      return Response.json({ ok: true, result: true });
    });
    await client.answerCallback("1-old-client");
    expect(calls).toBe(0);
  });

  test("rejects traversal paths and oversized downloads", async () => {
    const traversal = new BaleClient("token", async () => Response.json({ ok: true,
      result: { file_path: "../secret" } }));
    await expect(traversal.downloadFile("file")).rejects.toThrow("Invalid Bale file path");

    let calls = 0;
    const oversized = new BaleClient("token", async () => {
      calls += 1;
      if (calls === 1) return Response.json({ ok: true, result: { file_path: "files/a" } });
      return new Response(new Uint8Array([1]), { headers: { "content-length": String(21 * 1024 * 1024) } });
    });
    await expect(oversized.downloadFile("file")).rejects.toThrow("download limit");
  });
});
