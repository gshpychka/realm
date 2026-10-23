# End-to-end test of the platform: a Bay host running real nested session VMs, an "internet" host with an ntfy
# server, and a LAN host sessions must not reach.
{ inputs, pkgs }:
let
  inherit (inputs.nixpkgs) lib;
  bridgeAddress = "10.80.0.1";
  internetAddress = "198.51.100.10";
  # stands in for the site's own public address
  blockedAddress = "198.51.100.11";
  # fixtures for the throwaway ntfy server inside the test
  ntfyToken = "tk_0h74i4ptuuiaj8qbvgw53nrke5il0";
  ntfyHash = "$2y$10$QiPm9J/AUznrLDqN37qO0utkB99ycWr/9L.66rcTXlKmVCWugflMq";
in
inputs.nixpkgs.lib.nixos.runTest {
  hostPkgs = pkgs;
  name = "bay";
  qemu.forceAccel = true;

  nodes = {
    host =
      { config, pkgs, ... }:
      let
        counter = {
          command = [
            "counter"
            "fresh"
          ];
          resume = [
            "counter"
            "resume"
          ];
          history = [ ".counter/log" ];
          monitor = false;
        };
      in
      {
        imports = [ ../modules/system/nixos/bay.nix ];
        virtualisation = {
          cores = 4;
          memorySize = 8192;
          diskSize = 30 * 1024;
          vlans = [
            1
            2
          ];
        };
        networking.hostId = "8425e349";
        boot.zfs.forceImportRoot = false;
        boot.kernelParams = [ "zfs.zfs_arc_max=536870912" ];
        networking.interfaces.eth2.ipv4.addresses = lib.mkForce [
          {
            address = "198.51.100.1";
            prefixLength = 24;
          }
        ];

        users.users.alice.isNormalUser = true;
        environment.etc."bay-ntfy-token".text = ntfyToken;
        environment.etc."bay-test-server-config".source = lib.last (
          lib.splitString " " config.systemd.services.bay-server.serviceConfig.ExecStart
        );
        environment.etc."bay-test-reconfigure.py".text = ''
          import json
          import pathlib
          import subprocess
          import sys

          override = pathlib.Path("/run/systemd/system/bay-server.service.d/test.conf")
          if sys.argv[1] == "alternate":
              with open("/etc/bay-test-server-config") as source:
                  configuration = json.load(source)
              configuration["machines"]["default"] = configuration["machines"]["alternate"]
              pathlib.Path("/run/bay/test-server.json").write_text(json.dumps(configuration))
              override.parent.mkdir(parents=True, exist_ok=True)
              override.write_text("[Service]\nExecStart=\nExecStart=${config.services.bay.package}/bin/bay-server -config /run/bay/test-server.json\n")
          else:
              override.unlink()
          subprocess.run(["systemctl", "daemon-reload"], check=True)
          subprocess.run(["systemctl", "restart", "bay-server.service"], check=True)
        '';


        services.bay = {
          enable = true;
          operator = "alice";
          storage.size = "16GiB";
          network.address = "${bridgeAddress}/24";
          network.blockedAddresses = [ blockedAddress ];
          sessions = {
            cpus = 1;
            memory = 1;
            disk = 6;
            maxRunning = 2;
          };
          programs.counter = counter;
          machines.alternate = {
            inherit (config.services.bay.machines.default) metadata disk;
            resources = {
              cpus = 2;
              memory = 1;
              disk = 6;
            };
          };
          programs.alternate = counter // {
            machine = "alternate";
          };
          guest.modules = [
            (
              { pkgs, ... }:
              {
                environment.systemPackages = [
                  pkgs.curl
                  pkgs.python3
                  # logs how it was launched, counts seconds in memory, and logs a hangup two seconds after it arrives
                  (pkgs.writeShellScriptBin "counter" ''
                    mkdir -p ~/.counter
                    echo "start $1" >> ~/.counter/log
                    trap 'sleep 2; echo hangup >> ~/.counter/log; exit' HUP
                    n=0
                    while true; do
                      n=$((n + 1))
                      echo "$n" > ~/.counter/live
                      sleep 1
                    done
                  '')
                ];
              }
            )
          ];
          notifications = {
            url = "http://${internetAddress}:2586";
            topic = "bay";
            tokenFile = "/etc/bay-ntfy-token";
          };
        };

        # a host service on every interface: sessions must not reach it
        networking.firewall.allowedTCPPorts = [ 8001 ];
        systemd.services.host-web = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8001";
        };
      };

    internet =
      { pkgs, ... }:
      {
        virtualisation.vlans = [ 2 ];
        networking.interfaces.eth1.ipv4.addresses = lib.mkForce [
          {
            address = internetAddress;
            prefixLength = 24;
          }
          {
            address = blockedAddress;
            prefixLength = 24;
          }
        ];
        networking.firewall.allowedTCPPorts = [
          2586
          8000
        ];
        systemd.services.web = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8000";
        };
        services.ntfy-sh = {
          enable = true;
          settings = {
            base-url = "http://${internetAddress}:2586";
            listen-http = ":2586";
            auth-default-access = "deny-all";
            auth-users = [ "bay:${ntfyHash}:user" ];
            auth-tokens = [ "bay:${ntfyToken}" ];
            auth-access = [ "bay:bay:read-write" ];
          };
        };
      };

    lan =
      { pkgs, ... }:
      {
        virtualisation.vlans = [ 1 ];
        networking.firewall.allowedTCPPorts = [ 8000 ];
        systemd.services.web = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8000";
        };
      };
  };

  testScript =
    { nodes, ... }:
    let
      lanAddress = (builtins.head nodes.lan.networking.interfaces.eth1.ipv4.addresses).address;
      hostLanAddress = (builtins.head nodes.host.networking.interfaces.eth1.ipv4.addresses).address;
    in
    ''
      import json
      import shlex
      import time
      from datetime import timedelta

      def bay(args):
          return host.succeed(f"su - alice -c 'bay {args}'")

      def bay_fails(args):
          return host.fail(f"su - alice -c 'bay {args}' 2>&1")

      # incus exec forwards its stdin, which in the test driver is the console
      def guest(session, command):
          return host.succeed(f"incus exec --disable-stdin --project bay {session} -- {command}")

      def guest_fails(session, command):
          return host.fail(f"incus exec --disable-stdin --project bay {session} -- {command}")

      def state(session):
          return json.loads(bay(f"show {session} -json"))["state"]

      def live(session):
          return int(guest(session, "cat /home/dev/.counter/live").strip())

      def history(session):
          return guest(session, "cat /home/dev/.counter/log").strip().splitlines()

      # the counter rises by one a second for as long as its program runs
      def counting(session):
          before = live(session)
          time.sleep(3)
          return live(session) > before

      # what the counter logged for a session that ended and started again
      after_end = ["start fresh", "hangup", "start resume"]

      start_all()
      internet.wait_for_unit("ntfy-sh.service")
      internet.wait_for_unit("web.service")
      lan.wait_for_unit("web.service")
      host.wait_for_unit("bay-base.service", timeout=timedelta(seconds=1800))
      host.wait_for_unit("bay-server.service")
      host.wait_for_unit("bay-gateway.service")

      with subtest("a session launches and runs its program"):
          started = time.monotonic()
          bay("start one counter")
          print(f"launch time: {time.monotonic() - started:.1f}s")
          assert state("one") == "running"
          host.wait_until_succeeds("incus exec --disable-stdin --project bay one -- test -s /home/dev/.counter/live", timeout=timedelta(seconds=60))
          assert history("one") == ["start fresh"]
          assert guest("one", "hostname").strip() == "one"
          assert guest("one", "bay-session program").strip() == "running"
          # the guest sees no virtualization extensions
          guest_fails("one", "grep -qw -e vmx -e svm /proc/cpuinfo")

      with subtest("saving history writes nothing when no history path exists"):
          assert guest("one", "bay-session save-history -- .counter/none | wc -c").strip() == "0"

      with subtest("declared machines keep immutable bases and pinned sessions across catalog changes"):
          bay("start pinned counter")
          pinned = json.loads(bay("show pinned --json"))
          assert pinned["machine"] == "default" and pinned["machineRevision"], pinned
          bay("end pinned --yes")
          bay("start alternate alternate")
          alternate = json.loads(bay("show alternate --json"))
          assert alternate["machine"] == "alternate" and alternate["machineRevision"] != pinned["machineRevision"]
          assert host.succeed("incus config get --project bay alternate limits.cpu").strip() == "2"
          bases_before = json.loads(host.succeed("incus list --project bay --format json"))
          base_names = {item["name"] for item in bases_before if item["name"].startswith("bay-base-")}
          assert len(base_names) == 2, base_names
          bay("rm alternate --yes")
          host.succeed("${pkgs.python3}/bin/python3 /etc/bay-test-reconfigure.py alternate")
          try:
              bay("start pinned")
              resumed = json.loads(bay("show pinned --json"))
              assert resumed["machineRevision"] == pinned["machineRevision"] and resumed["id"] == pinned["id"]
              assert host.succeed("incus config get --project bay pinned limits.cpu").strip() == "1"
              bay("rm pinned --yes")
              bay("start fresh-machine counter")
              fresh = json.loads(bay("show fresh-machine --json"))
              assert fresh["machine"] == "default" and fresh["machineRevision"] == alternate["machineRevision"]
              assert host.succeed("incus config get --project bay fresh-machine limits.cpu").strip() == "2"
              stale_end = json.dumps({"id": pinned["id"], "snapshots": []})
              request = "curl -s -o /dev/null -w %{http_code} --unix-socket /run/bay/bay.sock -H Content-Type:application/json -d " + shlex.quote(stale_end) + " http://bay/v1/sessions/fresh-machine/end"
              status = host.succeed("su - alice -c " + shlex.quote(request)).strip()
              assert status == "409", status
              stale_suspend = json.dumps({"id": pinned["id"]})
              request = "curl -s -o /dev/null -w %{http_code} --unix-socket /run/bay/bay.sock -H Content-Type:application/json -d " + shlex.quote(stale_suspend) + " http://bay/v1/sessions/fresh-machine/suspend"
              status = host.succeed("su - alice -c " + shlex.quote(request)).strip()
              assert status == "409", status
              assert state("fresh-machine") == "running"
              bay("rm fresh-machine --yes")
              bases_after = json.loads(host.succeed("incus list --project bay --format json"))
              assert base_names <= {item["name"] for item in bases_after}
          finally:
              host.succeed("${pkgs.python3}/bin/python3 /etc/bay-test-reconfigure.py restore")

      with subtest("attaching needs a terminal and holds a client on the program's tmux"):
          assert "terminal" in bay_fails("attach one < /dev/null")
          # tmux needs a terminal type the guest has terminfo for
          status, screen = host.execute("su - alice -c 'script -qec \"timeout -k 10 5 env TERM=xterm-256color bay attach one\" /dev/null' < /dev/null")
          # timeout ends a client that is still attached
          assert status == 124, screen
          assert "[main]" in screen, screen
          assert "Pane is dead" not in screen, screen

      with subtest("the program cannot reconfigure the session's tmux, and extra panes leave its status alone"):
          guest_fails("one", "runuser -u dev -- /run/current-system/sw/bin/tmux -S /tmp/tmux-0/default set -g allow-passthrough on")
          guest("one", "tmux split-window -d -t main")
          assert guest("one", "bay-session program").strip() == "running"
          pane = guest("one", "tmux display-message -p -t main.1 '#{pane_pid}'").strip()
          retry(lambda _: "dev" in guest("one", f"ps -o user= --ppid {pane}").split(), timeout=timedelta(seconds=10))

      with subtest("a second session starts, and the cap refuses a third"):
          bay("start two counter")
          assert "of 2 sessions are running" in bay_fails("start three")

      with subtest("sessions reach the internet and nothing else"):
          guest("one", "curl -sf --max-time 10 http://${internetAddress}:8000/")
          guest_fails("one", "curl -sf --max-time 5 http://${blockedAddress}:8000/")
          guest_fails("one", "curl -sf --max-time 5 http://${lanAddress}:8000/")
          guest_fails("one", "curl -sf --max-time 5 http://${bridgeAddress}:8001/")
          guest_fails("one", "curl -sf --max-time 5 http://${hostLanAddress}:8001/")
          guest_fails("one", "curl -sf --max-time 5 http://198.51.100.1:8001/")
          host.succeed("curl -sf --max-time 5 http://${bridgeAddress}:8001/")
          two = guest("two", "ip -4 -o addr show scope global").split()[3].split("/")[0]
          host.execute("incus exec --disable-stdin --project bay two -- python3 -m http.server 8002 >/dev/null 2>&1 &")
          host.wait_until_succeeds("incus exec --disable-stdin --project bay two -- curl -sf http://127.0.0.1:8002/", timeout=timedelta(seconds=30))
          guest_fails("one", f"curl -sf --max-time 5 http://{two}:8002/")

      with subtest("sessions message each other under their own names"):
          assert guest("one", "flare whoami").strip() == "one"
          sent = json.loads(guest("one", "flare -json send -subject greeting two hello"))
          inbox = json.loads(guest("two", "flare -json inbox"))
          assert [t["id"] for t in inbox["threads"]] == [sent["thread"]]
          conversation = json.loads(guest("two", f"flare -json read {sent['thread']}"))
          assert [(m["from"], m["to"], m["body"]) for m in conversation["messages"]] == [("one", "two", "hello")]
          guest("two", f"flare send -thread {sent['thread']} one hi")

      with subtest("message cursors work through both clients and leave omitted messages unread"):
          latest = json.loads(guest("one", f"flare -json send -thread {sent['thread']} two newest"))
          page = json.loads(guest("two", f"flare -json read {sent['thread']} --before {latest['message']}"))
          assert [m["body"] for m in page["messages"]] == ["hello", "hi"], page
          inbox = json.loads(guest("two", "flare -json inbox"))
          assert inbox["threads"][0]["unread"] == 1, inbox
          operator_page = json.loads(bay(f"read {sent['thread']} --before {latest['message']} --json"))
          assert [m["id"] for m in operator_page["messages"]] == [m["id"] for m in page["messages"]], operator_page
          guest("two", f"flare read {sent['thread']}")
          assert json.loads(guest("two", "flare -json inbox"))["threads"] == []

      with subtest("agents reach the gateway through the image's MCP config"):
          mcp = json.loads(guest("one", "cat /etc/bay/mcp.json"))["mcpServers"]["bay"]
          call = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})
          reply = json.loads(host.succeed(f"echo '{call}' | incus exec --project bay one -- {mcp['command']} {' '.join(mcp['args'])}"))
          identity = json.loads(bay("show one --json"))
          assert reply["result"]["structuredContent"] == {field: identity[field] for field in ["name", "id", "generation"]}, reply

      with subtest("a session cannot read a thread it is not part of"):
          private = json.loads(bay("send -json -subject private two secret"))
          guest_fails("one", f"flare read {private['thread']}")
          threads = json.loads(bay("threads -json"))
          assert {t["id"] for t in threads} == {sent["thread"], private["thread"]}

      with subtest("alerts reach ntfy with only the session and the event"):
          guest("one", "flare notify done")
          guest("one", "flare send operator done-for-now")
          events = host.succeed(
              "curl -sf -H 'Authorization: Bearer ${ntfyToken}' 'http://${internetAddress}:2586/bay/json?poll=1'"
          ).strip().splitlines()
          messages = [(e["title"], e["message"]) for e in map(json.loads, events)]
          assert ("one", "done") in messages, messages
          assert ("one", "message") in messages, messages
          assert not any("done-for-now" in body for _, body in messages), messages

      with subtest("an ended session starts again with its history and resumes its program"):
          bay("end one --yes")
          assert state("one") == "ended"
          host.fail("incus info --project bay one")
          bay("start one")
          host.wait_until_succeeds(
              "incus exec --disable-stdin --project bay one -- grep -q 'start resume' /home/dev/.counter/log", timeout=timedelta(seconds=60)
          )
          # ending waits for the program's hangup handler, so its last line is in the saved history
          assert history("one") == after_end
          assert guest("one", "flare whoami").strip() == "one"
          assert json.loads(guest("one", "flare -json inbox"))["threads"], "one's inbox survives its restart"

      with subtest("a suspended session resumes where it was"):
          before = live("one")
          session = json.loads(bay("show one --json"))
          suspend = json.dumps({"id": session["id"]})
          request = "curl -fsS --unix-socket /run/bay/bay.sock -H Content-Type:application/json -d " + shlex.quote(suspend) + " http://bay/v1/sessions/one/suspend"
          host.succeed("su - alice -c " + shlex.quote(request))
          assert state("one") == "suspended"
          bay("start three counter")
          assert "of 2 sessions are running" in bay_fails("resume one")
          bay("end three --yes")
          bay("resume one")
          time.sleep(3)
          assert live("one") > before
          assert history("one") == after_end

      with subtest("a snapshot restores a running session"):
          bay("snap one checkpoint")
          at_snapshot = live("one")
          time.sleep(15)
          assert "checkpoint" in bay_fails("end one < /dev/null")
          bay("resume one --snapshot checkpoint")
          assert live("one") < at_snapshot + 10

      with subtest("running sessions carry on across a reboot, suspended ones stay suspended"):
          bay("suspend two")
          live_one = live("one")
          boot_id = guest("one", "cat /proc/sys/kernel/random/boot_id")
          host.shutdown()
          host.start()
          host.wait_for_unit("bay-server.service")
          host.wait_until_succeeds("su - alice -c 'bay show one -json' | grep -q running", timeout=timedelta(seconds=600))
          host.wait_until_succeeds("incus exec --disable-stdin --project bay one -- true", timeout=timedelta(seconds=300))
          # a cold boot has a new boot ID, and leaves the counter file behind with no program counting
          assert guest("one", "cat /proc/sys/kernel/random/boot_id") == boot_id
          resumed = live("one")
          assert resumed >= live_one
          time.sleep(3)
          assert live("one") > resumed
          assert history("one") == after_end
          assert state("two") == "suspended"

      with subtest("a session whose program stopped says so, and resuming starts the program again"):
          bay_fails("resume one")
          guest("one", "bay-session stop")
          assert guest("one", "bay-session program").strip() == "stopped"
          # stop returns once the program has finished its hangup handler
          assert history("one") == [*after_end, "hangup"]
          status, screen = host.execute("su - alice -c 'script -qec \"timeout -k 10 20 bay attach one\" /dev/null' < /dev/null")
          assert status == 1, screen
          assert "the program is not running; bay resume one starts it again" in screen, screen
          bay("resume one")
          retry(lambda _: history("one")[-1] == "start resume", timeout=timedelta(seconds=60))
          assert guest("one", "bay-session program").strip() == "running"
          assert counting("one")
          assert history("one") == [*after_end, "hangup", "start resume"]
          # a program that exits on its own leaves its pane behind, and resuming starts it again
          guest("one", "pkill -HUP -f 'counter resume'")
          retry(lambda _: guest("one", "bay-session program").strip() == "stopped", timeout=timedelta(seconds=30))
          bay("resume one")
          retry(lambda _: history("one")[-1] == "start resume", timeout=timedelta(seconds=60))
          assert counting("one")
          assert history("one") == [*after_end, "hangup", "start resume", "hangup", "start resume"]

      with subtest("rm removes the instance, the record and the volumes"):
          bay("rm two --yes")
          bay_fails("show two")
          host.fail("incus info --project bay two")
          host.fail("test -e /var/lib/bay/sessions/two")
          host.fail("zfs list -H -o name | grep -E '/(bay_)?two(\\.block)?$'")
    '';
}
