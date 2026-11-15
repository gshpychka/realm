{
  pkgs ? import <nixpkgs> { },
}:
pkgs.runCommand "vetro-source-shortcuts" { nativeBuildInputs = [ pkgs.mono ]; } ''
  mkdir -p "$out"
  mcs -warnaserror -target:exe -out:"$out/SourceShortcut.dll" ${./SourceShortcut.cs}
  cat > "$out/SourceShortcut.runtimeconfig.json" <<'JSON'
  {"runtimeOptions":{"tfm":"net6.0","rollForward":"Major","framework":{"name":"Microsoft.NETCore.App","version":"6.0.0"}}}
  JSON
''
