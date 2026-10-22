{ pkgs }:
pkgs.runCommand "home-assistant-migration-qa"
  {
    nativeBuildInputs = with pkgs; [
      bash
      coreutils
      curl
      gnutar
      jq
      mosquitto
      openssh
      (python3.withPackages (ps: [ ps.pyyaml ]))
      restic
      ripgrep
      rsync
      shellcheck
      util-linux
      yq-go
    ];
  }
  ''
    export PYTHONDONTWRITEBYTECODE=1
    shellcheck ${../../migration}/*.sh
    python ${./test_runbook.py} ${../../migration/migrate.sh}
    python ${./test_reconcile.py} ${../../migration/reconcile-ha.sh}
    python ${./test_prepare_yasno.py} ${../../migration/prepare-yasno.sh}
    python ${./test_inventory_helpers.py} ${../../migration/collect-yasno.sh} ${../../migration/glances-map.sh}
    python ${./test_install_target.py} ${../../migration/install-target.sh}
    python ${./test_capture_restore.py} ${../../migration}
    python ${./test_config_drift.py} ${../../migration}
    touch $out
  ''
