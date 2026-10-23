import { type Static, Type } from "@earendil-works/pi-ai";

const id = Type.String({ minLength: 1, maxLength: 256 });
const text = Type.String({ minLength: 1, maxLength: 65536 });
const params = <T extends Record<string, import("@earendil-works/pi-ai").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
/** Native tool schemas are the single declaration of model-visible commands. */
export const commandSchemas = {
  delegate: params({
    agent: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$" }),
    objective: text,
    acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
    dependsOn: Type.Optional(Type.Array(id, { maxItems: 32, uniqueItems: true })),
  }),
  inspect: params({ taskId: Type.Optional(id) }),
  message: params({ to: id, body: text, replyTo: Type.Optional(id) }),
  ask: params({
    question: text,
    choices: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
        minItems: 1,
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
  }),
  submit: params({ summary: text, artifact: Type.Optional(Type.Boolean()) }),
  yield: params({ reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }),
};
export type CommandName = keyof typeof commandSchemas;
export type DomainCommand = {
  [K in CommandName]: { type: K } & Static<(typeof commandSchemas)[K]>;
}[CommandName];
