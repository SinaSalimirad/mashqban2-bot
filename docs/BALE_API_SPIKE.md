# Bale Bot API — initial contract review

Reviewed 2026-11-25 from the [official Bale Bot API documentation](https://docs.bale.ai/). This is a documentation review, not a live test-bot result. No token or student data was used.

## Confirmed from the official documentation

- API requests use HTTPS at `https://tapi.bale.ai/bot<token>/<method>`; JSON POST is supported except for file uploads. Responses include `ok`, with `result` on success and `error_code` on failure.
- `getUpdates` supports long polling, `offset`, `limit` (1–100), and `timeout`. An update is acknowledged by a later request whose offset exceeds its `update_id`. Bale currently retains the last 2,000 updates for 24 hours before receipt.
- Webhooks are also supported, using HTTPS POST on documented ports 443 or 88. Only one transport should run for a bot.
- Updates expose `update_id`, with message or callback data. Validate sender and private chat fields against actual updates before implementing routing.
- File IDs can be reused for the same bot. `getFile` permits downloads up to 20 MB; returned download links are guaranteed for one hour, and can be refreshed. The docs do not guarantee permanent retention of the original file.
- Inline buttons and callback queries are documented. Media types and exact operational limits need contract tests before accepting uploads.

## Initial transport choice

Use **long polling** for the single-instance MVP. It needs no public endpoint. Persist each update in PostgreSQL before advancing the offset; process persisted updates independently so a crash does not lose them. Never start a second poller for the same bot instance. This is a design choice based on the documented contract, pending a test-bot smoke test and deployment check.

## Still to verify with a test bot

- Sanitized request/response samples for polling, callbacks, media, errors, and outbound messages.
- Exact `update_id` and user/chat ID ranges, private-chat shapes, callback payload limit, edit behavior, media groups, voice handling, and actual file resend/download behavior over time.
- API rate limits, transient errors/retry hints, webhook authentication, and behavior around restarts and a 24-hour outage.

The 24-hour upstream retention means the application cannot reconstruct updates that Bale has already expired. Monitoring, timely restart, and durable local ingestion are required.

## BOT_UX feasibility review (2026-11-26)

The [official Bale bot documentation](https://docs.bale.ai/) confirms that the main chat-based UX is feasible: `sendMessage` accepts inline and reply keyboards, inline buttons produce `callback_query` updates, `answerCallbackQuery` acknowledges clicks, and `editMessageText` can replace a bot message and its keyboard. `callback_data` is limited to 1–64 bytes, so the implementation sends a short opaque token and keeps the action in PostgreSQL. The bot also has `sendPhoto`, `sendDocument`, `sendVideo`, `sendAudio`, `sendVoice`, and `getFile` methods; `getFile` limits downloads to 20 MB.

There are documented limits: `setMyCommands` exposes one shared slash-command list for the entire bot, so role-specific menus must be rendered in chat and checked on the server. Old Bale clients may not support the callback acknowledgment UI; for callback IDs beginning with `1`, the bot sends a normal message. An incoming album item exposes `media_group_id`, but the API documentation does not define a reliable album-complete event. The bot therefore collects each incoming file as a separate draft item and requires the user to review the count before finalizing. `sendMediaGroup` currently supports photo/video only, so it is not the path for arbitrary homework files.

The implementation now uses inline menus, one-use scoped callback tokens, message editing with a send-new-message fallback, private-chat workflows, pagination, and text-command fallbacks. These are documentation-backed choices, not a live contract result. A test bot is still needed to verify old-client behavior, exact callback shapes, media groups, voice codecs, and upload limits before real student use.
