// Pi's login screen writes a bare OSC 52 on Ctrl+X. Exercise that protocol without OAuth.
const url = "https://example.test/sign-in";
process.stdin.setRawMode(true);
process.stdout.write("clipboard ready\n");
process.stdin.on("data", (chunk) => {
  if (chunk.includes(3)) process.exit(0);
  if (chunk.includes(24)) {
    process.stdout.write(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07copied\n`);
  }
});
