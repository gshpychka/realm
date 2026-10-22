{ pymodbus }:
# Diagnostic tests mutate a process-wide ASCII delimiter. Reset it between
# tests so a single pytest worker keeps unrelated framer fixtures isolated.
pymodbus.overridePythonAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./pymodbus-test-isolation.patch ];
})
