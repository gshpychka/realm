# Closed constructors for simple references; authored expressions stay in Jinja.
let
  reserved = [
    "and"
    "or"
    "not"
    "in"
    "is"
    "if"
    "else"
    "for"
    "recursive"
    "true"
    "false"
    "none"
    "True"
    "False"
    "None"
  ];
  identifier =
    value: builtins.isString value && builtins.match "[A-Za-z_][A-Za-z0-9_]*" value != null;
  ref =
    path:
    assert builtins.isList path && path != [ ] && builtins.all identifier path;
    assert !(builtins.elem (builtins.head path) reserved);
    {
      reference = path;
    };
in
{
  inherit ref;
  variable = name: ref [ name ];
}
