import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The bot's token from @BotFather. */
export const BotToken = Config.Redacted("TELEGRAM_BOT_TOKEN");

/** Header carrying the webhook's secret token on every update Telegram posts. */
export const secretTokenHeader = "x-telegram-bot-api-secret-token";

// https://core.telegram.org/bots/api#available-types, the fields the bot reads

export const MessageEntity = Schema.Struct({
  type: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
});
export type MessageEntity = typeof MessageEntity.Type;

export const Message = Schema.Struct({
  message_id: Schema.Number,
  chat: Schema.Struct({ id: Schema.Number }),
  text: Schema.optionalKey(Schema.String),
  entities: Schema.optionalKey(Schema.Array(MessageEntity)),
});
export type Message = typeof Message.Type;

export const Update = Schema.Struct({
  message: Schema.optionalKey(Message),
});

export const SendMessageParams = Schema.Struct({
  chat_id: Schema.Number,
  text: Schema.String,
  reply_parameters: Schema.Struct({ message_id: Schema.Number }),
});
export type SendMessageParams = typeof SendMessageParams.Type;

export interface SetWebhookParams {
  readonly url: string;
  readonly secret_token: string;
  readonly allowed_updates: readonly string[];
}

const ApiResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.String,
    error_code: Schema.optionalKey(Schema.Number),
  }),
]);

export class BotApiError extends Data.TaggedError("BotApiError")<{
  readonly method: string;
  readonly description: string;
  readonly delivery: "rejected" | "unknown";
}> {}

// https://core.telegram.org/bots/api#making-requests
const callBotApi = (token: Redacted.Redacted<string>, method: string, params: object) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`https://api.telegram.org/bot${Redacted.value(token)}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      }).then((response) => response.json()),
    // the request URL embeds the token, so the cause stays out of the error
    catch: () => new BotApiError({ method, description: "request failed", delivery: "unknown" }),
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(ApiResponse)(response).pipe(
        Effect.mapError(
          () => new BotApiError({ method, description: "invalid response", delivery: "unknown" }),
        ),
      ),
    ),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.fail(
            new BotApiError({
              method,
              description: response.description,
              delivery:
                response.error_code !== undefined &&
                response.error_code >= 400 &&
                response.error_code < 500
                  ? "rejected"
                  : "unknown",
            }),
          ),
    ),
  );

export const setWebhook = (token: Redacted.Redacted<string>, params: SetWebhookParams) =>
  callBotApi(token, "setWebhook", params);

export const deleteWebhook = (token: Redacted.Redacted<string>) =>
  callBotApi(token, "deleteWebhook", {});

export const sendMessage = (token: Redacted.Redacted<string>, params: SendMessageParams) =>
  callBotApi(token, "sendMessage", params);
