import * as AWS from "alchemy/AWS";
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as SQS from "alchemy/AWS/SQS";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Replies, ReplyAttempts, replyAttemptRetention } from "./replies.ts";
import { BotToken, SendMessageParams, sendMessage } from "./telegram.ts";

const decodeReply = Schema.decodeEffect(Schema.fromJsonString(SendMessageParams));

/** Sends one reserved reply per original chat and message. */
export default class Sender extends AWS.Lambda.Function<Sender>()(
  "Sender",
  { main: import.meta.url, functionUrl: false },
  Effect.gen(function* () {
    const token = yield* BotToken;
    const attempts = yield* ReplyAttempts;
    const reserve = yield* DynamoDB.PutItem(attempts);
    const release = yield* DynamoDB.DeleteItem(attempts);

    const sendReply = Effect.fn(function* (reply: SendMessageParams) {
      const id = `${reply.chat_id}:${reply.reply_parameters.message_id}`;
      const attempt = crypto.randomUUID();
      const expiresAt = Math.floor(
        (yield* Clock.currentTimeMillis) / 1000 + Duration.toSeconds(replyAttemptRetention),
      );
      const reserved = yield* reserve({
        Item: {
          id: { S: id },
          attempt: { S: attempt },
          expiresAt: { N: String(expiresAt) },
        },
        ConditionExpression: "attribute_not_exists(#id)",
        ExpressionAttributeNames: { "#id": "id" },
      }).pipe(
        Effect.as(true),
        Effect.catchTag("ConditionalCheckFailedException", () => Effect.succeed(false)),
      );
      if (!reserved) return;

      yield* sendMessage(token, reply).pipe(
        Effect.catchTag("BotApiError", (error) =>
          Effect.gen(function* () {
            if (error.delivery === "rejected") {
              yield* release({
                Key: { id: { S: id } },
                ConditionExpression: "#attempt = :attempt",
                ExpressionAttributeNames: { "#attempt": "attempt" },
                ExpressionAttributeValues: { ":attempt": { S: attempt } },
              }).pipe(Effect.catchTag("ConditionalCheckFailedException", () => Effect.void));
            }
            return yield* Effect.fail(error);
          }),
        ),
      );
    });

    // one reply per batch, so a failed send redelivers only that reply
    yield* SQS.consumeQueueMessages(Replies, { batchSize: 1 }, (records) =>
      records.pipe(
        Stream.runForEach((record) => decodeReply(record.body).pipe(Effect.flatMap(sendReply))),
        Effect.orDie,
      ),
    );

    return {};
  }).pipe(
    Effect.provide([AWS.Lambda.QueueEventSource, DynamoDB.PutItemHttp, DynamoDB.DeleteItemHttp]),
  ),
) {}
