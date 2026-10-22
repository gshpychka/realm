{ python-overseerr }:
# aiohttp/yarl encode params themselves; pre-quoting turns spaces, Unicode and
# reserved characters into literal percent escapes in the server's search term.
python-overseerr.overridePythonAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./query-encoding.patch ];
  postPatch = (old.postPatch or "") + ''
    cp ${./test_search_query.py} tests/test_search_query.py
  '';
})
