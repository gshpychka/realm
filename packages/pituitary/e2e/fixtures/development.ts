// A minimal terminal for exercising the development driver's lifecycle and input.
process.stdin.setRawMode(true);
process.stdout.write(`ready ${process.env.PITUITARY_DRIVER_PROBE ?? "missing"}\r\n`);
process.stdin.on("data", (chunk) => {
  if (chunk.includes(4)) process.exit(0);
  process.stdout.write(chunk);
});
