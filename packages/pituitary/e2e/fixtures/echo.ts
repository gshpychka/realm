// Echoes each key the moment it arrives: the harness's own floor for key-to-screen latency.
process.stdin.setRawMode(true);
process.stdout.write("ready\n");
process.stdin.on("data", (chunk) => {
  if (chunk.includes(3)) process.exit(0);
  process.stdout.write(chunk);
});
