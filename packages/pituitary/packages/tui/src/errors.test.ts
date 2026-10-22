import { describe, expect, test } from "bun:test";
import { explain } from "./errors.ts";

/** What pi reports when Anthropic turns down an expired refresh token, as pi 0.87 writes it. */
const EXPIRED = [
  'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}; stack=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}',
  "    at postJson (/$bunfs/root/pi:275778:11)",
  "    at refreshAnthropicToken (/$bunfs/root/pi:275898:34)",
  "    at processTicksAndRejections (native)",
].join("\n");

describe("provider logins", () => {
  test("an expired refresh token reads as an expired login, with the command that signs in", () => {
    expect(explain(EXPIRED)).toEqual({
      text: "the anthropic login has expired",
      remedy: { command: "/login anthropic", does: "signs in again" },
      original: EXPIRED,
    });
  });

  test("a refresh that never reached the provider blames the network, not the login", () => {
    const offline =
      "OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com";
    expect(explain(offline)).toMatchObject({ text: "could not reach anthropic to renew the login" });
    expect(explain(offline).remedy).toBeUndefined();
  });

  test("a refresh the provider failed for another reason still offers to sign in", () => {
    const failed =
      "OAuth refresh failed for openai-codex: Token refresh failed. status=500; body=upstream unavailable";
    expect(explain(failed)).toMatchObject({
      text: "could not renew the openai-codex login",
      remedy: { command: "/login openai-codex" },
    });
  });

  test("pi's own guidance reads in the same words", () => {
    expect(
      explain(
        `Authentication failed for "anthropic". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.`,
      ),
    ).toMatchObject({
      text: "the anthropic login did not work: it may have expired, or the network is down",
      remedy: { command: "/login anthropic", does: "signs in again" },
    });
    expect(
      explain(
        "No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md",
      ),
    ).toMatchObject({ text: "no login or API key for anthropic", remedy: { command: "/login anthropic" } });
    expect(explain("No API key found for the selected model.")).toMatchObject({
      remedy: { command: "/login" },
    });
  });

  test("a provider's 401 keeps only the message its body carries", () => {
    const refused =
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CXYZ"}';
    expect(explain(refused)).toEqual({
      text: "the provider refused the credentials: invalid x-api-key",
      remedy: { command: "/login", does: "signs in again" },
      original: refused,
    });
  });
});

describe("MCP servers", () => {
  test("a server that wants a login names the command that signs in to it", () => {
    expect(
      explain("MCP: Failed to connect to linear: OAuth authentication required. Run /mcp-auth linear."),
    ).toMatchObject({
      text: "MCP server linear needs a login",
      remedy: { command: "/mcp-auth linear", does: "signs in" },
    });
    expect(
      explain(
        'MCP: Failed to reconnect to notion: Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing or invalid access token"} — probe: auth-required',
      ),
    ).toMatchObject({ text: "MCP server notion needs a login" });
  });

  test("a transport failure reads as its cause", () => {
    expect(
      explain(
        "MCP: Failed to connect to local: fetch failed — ECONNREFUSED — macOS Local Network Privacy may be blocking access.",
      ),
    ).toMatchObject({
      text: "MCP server local did not connect: connection refused",
      remedy: { command: "/mcp reconnect local", does: "tries again" },
    });
    expect(explain("MCP: Failed to connect to fs: spawn mcp-fs ENOENT")).toMatchObject({
      text: "MCP server fs did not connect: its command was not found",
    });
    expect(
      explain("MCP: Failed to connect to fs: MCP error -32000: Connection closed (Error: bad config)"),
    ).toMatchObject({
      text: "MCP server fs did not connect: the server closed the connection",
    });
  });

  test("an error page reads as its title, without the transport's wrappers", () => {
    expect(
      explain(
        "MCP: Failed to connect to jira: Streamable HTTP error: Error POSTing to endpoint: <!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html> — probe: endpoint not reachable",
      ),
    ).toMatchObject({ text: "MCP server jira did not connect: 502 Bad Gateway" });
  });
});

describe("any other error", () => {
  test("short words pass through untouched", () => {
    expect(explain("400 invalid_request_error: prompt is too long")).toEqual({
      text: "400 invalid_request_error: prompt is too long",
    });
    expect(explain("529 overloaded_error")).toEqual({ text: "529 overloaded_error" });
  });

  test("a stack trace is dropped, and the error's class with it", () => {
    const thrown =
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at run (/ext/index.ts:4:9)";
    expect(explain(thrown)).toEqual({
      text: "Cannot read properties of undefined (reading 'x')",
      original: thrown,
    });
  });

  test("a response body reads as its message", () => {
    expect(
      explain(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      ).text,
    ).toBe("400 prompt is too long: 210000 tokens > 200000 maximum");
  });

  test("a body that carries no message is left as it is", () => {
    expect(explain('error {"retry": true}').text).toBe('error {"retry": true}');
  });

  test("diagnostics after a sentence are dropped", () => {
    expect(
      explain("Token exchange request failed. url=https://example.com/token; details=Error: boom").text,
    ).toBe("Token exchange request failed.");
  });

  test("a long line is cut at a word, and only the first line shows", () => {
    const long = `${"word ".repeat(60)}\nsecond line`;
    const { text, original } = explain(long);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith("word…")).toBe(true);
    expect(original).toBe(long);
  });
});
