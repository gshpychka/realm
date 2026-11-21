import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as SQS from "alchemy/AWS/SQS";
import * as Duration from "effect/Duration";

/** Replies to send, each a `SendMessageParams` as JSON. */
export const Replies = SQS.Queue("Replies", { messageRetentionPeriod: "4 days" });

export const replyAttemptRetention = Duration.days(7);

/** Delivery reservations keyed by the original chat and message. */
export const ReplyAttempts = DynamoDB.Table("ReplyAttempts", {
  partitionKey: "id",
  attributes: { id: "S" },
  billingMode: "PAY_PER_REQUEST",
  timeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
});
