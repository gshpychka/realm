# tmux doesn't relay the kitty clipboard protocol (OSC 5522) between panes and the
# client terminal: https://github.com/tmux/tmux/issues/5837
_final: prev: {
  tmux = prev.tmux.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./tmux-kitty-clipboard.patch ];
  });
}
