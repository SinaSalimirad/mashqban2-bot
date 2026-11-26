export type BaleMessage = {
  message_id: number;
  from?: { id: number };
  chat: { id: number; type: string };
  text?: string;
  media?: { kind: "photo" | "document" | "video" | "voice" | "audio"; fileId: string;
    mimeType?: string; originalName?: string; sizeBytes?: number };
};

export type BaleUpdate = {
  update_id: number;
  message?: BaleMessage;
  callback_query?: { id: string; from: { id: number }; data?: string;
    message?: { message_id?: number; chat: { id: number; type: string } } };
};

export type BaleButton = { text: string; callback_data: string; style?: "primary" | "success" | "danger" };

export class BaleApiError extends Error {
  constructor(public readonly code: number | null, public readonly retryAfter: number | null) {
    super("Bale API request failed");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Bale API response");
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Unsupported Bale identifier");
  }
  return value;
}

function safeChatId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    throw new Error("Unsupported Bale chat identifier");
  }
  return value;
}

function parseMedia(message: Record<string, unknown>): BaleMessage["media"] {
  if (message.media !== undefined) {
    const media = object(message.media);
    const kind = media.kind;
    if ((kind === "photo" || kind === "document" || kind === "video" || kind === "voice" || kind === "audio")
      && typeof media.fileId === "string") {
      return { kind, fileId: media.fileId,
        ...(typeof media.mimeType === "string" ? { mimeType: media.mimeType } : {}),
        ...(typeof media.originalName === "string" ? { originalName: media.originalName } : {}),
        ...(typeof media.sizeBytes === "number" ? { sizeBytes: safeId(media.sizeBytes) } : {}),
      };
    }
    throw new Error("Invalid Bale media");
  }
  const candidates = ["voice", "document", "video", "audio"] as const;
  for (const kind of candidates) {
    if (message[kind] === undefined) continue;
    const media = object(message[kind]);
    if (typeof media.file_id !== "string" || !media.file_id) throw new Error("Invalid Bale media");
    return { kind, fileId: media.file_id,
      ...(typeof media.mime_type === "string" ? { mimeType: media.mime_type } : {}),
      ...(typeof media.file_name === "string" ? { originalName: media.file_name } : {}),
      ...(media.file_size !== undefined ? { sizeBytes: safeId(media.file_size) } : {}),
    };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const photos = message.photo.map(object);
    const largest = photos.reduce((best, next) =>
      Number(next.file_size ?? 0) > Number(best.file_size ?? 0) ? next : best);
    if (typeof largest.file_id !== "string" || !largest.file_id) throw new Error("Invalid Bale photo");
    return { kind: "photo", fileId: largest.file_id,
      ...(largest.file_size !== undefined ? { sizeBytes: safeId(largest.file_size) } : {}) };
  }
  return undefined;
}

export function parseUpdate(value: unknown): BaleUpdate {
  const update = object(value);
  const updateId = safeId(update.update_id);
  if (update.callback_query !== undefined) {
    const callback = object(update.callback_query);
    const from = object(callback.from);
    const message = callback.message === undefined ? undefined : object(callback.message);
    const chat = message ? object(message.chat) : undefined;
    if (typeof callback.id !== "string" || !callback.id) throw new Error("Invalid Bale callback");
    return { update_id: updateId, callback_query: {
      id: callback.id, from: { id: safeId(from.id) },
      ...(typeof callback.data === "string" ? { data: callback.data } : {}),
      ...(chat ? { message: {
        chat: { id: safeChatId(chat.id), type: String(chat.type) },
        ...(message?.message_id === undefined ? {} : { message_id: safeId(message.message_id) }),
      } } : {}),
    } };
  }
  if (update.message === undefined) return { update_id: updateId };
  const message = object(update.message);
  const chat = object(message.chat);
  const from = message.from === undefined ? undefined : object(message.from);
  const media = parseMedia(message);
  return {
    update_id: updateId,
    message: {
      message_id: safeId(message.message_id),
      chat: { id: safeChatId(chat.id), type: String(chat.type) },
      ...(from ? { from: { id: safeId(from.id) } } : {}),
      ...(typeof message.text === "string" ? { text: message.text } : {}),
      ...(media ? { media } : {}),
    },
  };
}

export class BaleClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://tapi.bale.ai/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Bale network outcome unknown");
    }
    let payload: Record<string, unknown>;
    try {
      payload = object(await response.json());
    } catch {
      throw new Error("Bale response outcome unknown");
    }
    if (payload.ok !== true) {
      const parameters = payload.parameters && typeof payload.parameters === "object" ? object(payload.parameters) : {};
      throw new BaleApiError(
        typeof payload.error_code === "number" ? payload.error_code : response.status,
        typeof parameters.retry_after === "number" ? parameters.retry_after : null,
      );
    }
    return payload.result;
  }

  async getUpdates(offset?: number): Promise<BaleUpdate[]> {
    const result = await this.call("getUpdates", { offset, timeout: 25, limit: 100 }, 35_000);
    if (!Array.isArray(result)) throw new Error("Invalid Bale updates response");
    return result.map(parseUpdate);
  }

  async sendText(chatId: string, message: string,
    buttons?: BaleButton[][]): Promise<string> {
    const text = message.length > 4000 ? `${message.slice(0, 3970)}\n… متن طولانی بود؛ از صفحه‌بندی استفاده کنید.` : message;
    const result = object(await this.call("sendMessage", { chat_id: chatId, text,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    }, 15_000));
    return String(safeId(result.message_id));
  }

  async editText(chatId: string, messageId: number, message: string,
    buttons?: BaleButton[][]): Promise<string> {
    const text = message.length > 4000 ? `${message.slice(0, 3970)}\n… متن طولانی بود؛ از صفحه‌بندی استفاده کنید.` : message;
    const result = object(await this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text,
      reply_markup: { inline_keyboard: buttons ?? [] },
    }, 15_000));
    return String(safeId(result.message_id));
  }

  async answerCallback(callbackId: string): Promise<void> {
    if (callbackId.startsWith("1")) return;
    await this.call("answerCallbackQuery", { callback_query_id: callbackId }, 5_000);
  }

  async sendVoice(chatId: string, audio: Uint8Array): Promise<string> {
    return this.sendMedia(chatId, "voice", audio, "audio/ogg");
  }

  async sendMedia(chatId: string, kind: "photo" | "document" | "video" | "voice" | "audio",
    bytes: Uint8Array, mimeType: string): Promise<string> {
    const method = { photo: "sendPhoto", document: "sendDocument", video: "sendVideo",
      voice: "sendVoice", audio: "sendAudio" }[kind];
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set(kind, new Blob([new Uint8Array(bytes)], { type: mimeType }), `mashqban-${kind}`);
    let response: Response;
    try {
      response = await this.fetcher(`https://tapi.bale.ai/bot${this.token}/${method}`, {
        method: "POST", body: form, signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Bale voice delivery outcome unknown");
    }
    let payload: Record<string, unknown>;
    try {
      payload = object(await response.json());
    } catch {
      throw new Error("Bale voice response outcome unknown");
    }
    if (payload.ok !== true) {
      throw new BaleApiError(typeof payload.error_code === "number" ? payload.error_code : response.status, null);
    }
    return String(safeId(object(payload.result).message_id));
  }

  async downloadFile(fileId: string): Promise<ReadableStream<Uint8Array>> {
    const file = object(await this.call("getFile", { file_id: fileId }, 15_000));
    const path = file.file_path;
    if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("Invalid Bale file path");
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://tapi.bale.ai/file/bot${this.token}/${path}`, {
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error("Bale file download failed");
    }
    if (!response.ok || !response.body) throw new Error("Bale file download failed");
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > 20 * 1024 * 1024) {
      await response.body.cancel();
      throw new Error("Bale file exceeds download limit");
    }
    return response.body;
  }
}
