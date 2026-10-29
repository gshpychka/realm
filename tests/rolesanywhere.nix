# VM test of services.rolesanywhere on an emulated TPM2: the CA key the TPM2
# derives (the same across a reboot, another after a PCR 7 change), who gets a
# certificate, and aws_signing_helper trading one for credentials at a
# stand-in for the Roles Anywhere endpoint.
#   nix build .#checks.x86_64-linux.rolesanywhere-vm
{ pkgs }:
let
  # records one CreateSession request and answers it with dummy credentials,
  # shaped like the real response
  # (https://docs.aws.amazon.com/rolesanywhere/latest/APIReference/API_CreateSession.html)
  endpoint = pkgs.writeText "endpoint.py" ''
    import json, sys
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            with open(sys.argv[1], "w") as out:
                json.dump({"path": self.path, "headers": dict(self.headers), "body": body.decode()}, out)
            credentials = {"accessKeyId": "ASIATEST", "secretAccessKey": "secret", "sessionToken": "token",
                           "expiration": "2030-01-01T00:00:00Z"}
            reply = json.dumps({"credentialSet": [{"credentials": credentials}]}).encode()
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    HTTPServer(("127.0.0.1", 8099), Handler).serve_forever()
  '';
  account = "000000000000";
  rolesanywhere = pkgs.lib.getExe (pkgs.callPackage ../packages/rolesanywhere { });
in
pkgs.testers.runNixOSTest {
  name = "rolesanywhere";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ ../modules/system/nixos/rolesanywhere.nix ];
      virtualisation.tpm.enable = true;
      users.users = {
        alice.isNormalUser = true;
        bob.isNormalUser = true;
      };
      services.rolesanywhere = {
        enable = true;
        clients = [ "alice" ];
        # The CA key is derived in the VM's TPM2, after the build, so the test
        # registers its certificate by writing this file.
        caCertificate = "/etc/rolesanywhere-test/registered.pem";
      };
      environment.systemPackages = [
        pkgs.openssl
        pkgs.tpm2-tools
      ];
      environment.variables.TPM2TOOLS_TCTI = "device:/dev/tpmrm0";
    };

  testScript = ''
    import base64
    import json
    from datetime import datetime, timedelta

    registered = "/etc/rolesanywhere-test/registered.pem"
    arns = (
        "--trust-anchor-arn arn:aws:rolesanywhere:us-east-1:${account}:trust-anchor/11111111-1111-1111-1111-111111111111 "
        "--profile-arn arn:aws:rolesanywhere:us-east-1:${account}:profile/22222222-2222-2222-2222-222222222222 "
        "--role-arn arn:aws:iam::${account}:role/test"
    )


    def certificate_as(user: str) -> str:
        return machine.succeed(f"su - {user} -c 'rolesanywhere-credentials --certificate'")


    def refusal_as(user: str) -> str:
        return machine.fail(f"su - {user} -c 'rolesanywhere-credentials --certificate' 2>&1")


    def register() -> str:
        """Registers a CA certificate for the TPM2's current CA key; returns the key."""
        machine.succeed("${rolesanywhere} ca-certificate > /tmp/ca.pem")
        machine.succeed(f"install -D -m 0644 /tmp/ca.pem {registered}")
        return machine.succeed(f"openssl x509 -in {registered} -noout -pubkey")


    def check_alice() -> None:
        machine.succeed(f"cat > /tmp/alice.pem <<'EOF'\n{certificate_as('alice')}EOF")
        machine.succeed(f"openssl verify -x509_strict -CAfile {registered} /tmp/alice.pem")


    machine.wait_for_unit("rolesanywhere.socket")

    with subtest("nothing is issued before a CA certificate is registered"):
        assert f"No such file or directory: '{registered}'" in refusal_as("alice")

    with subtest("the TPM2 derives the same CA key each time"):
        first = register()
        assert register() == first
        text = machine.succeed(f"openssl x509 -in {registered} -noout -text")
        assert "CA:TRUE, pathlen:0" in text, text
        assert "Certificate Sign" in text, text

    with subtest("alice gets a 5-minute certificate for machine:alice"):
        check_alice()
        assert "subject=CN=machine:alice" in machine.succeed("openssl x509 -in /tmp/alice.pem -noout -subject")
        # valid for 5 minutes, after a minute's leeway for clock skew
        dates = dict(
            line.split("=", 1)
            for line in machine.succeed("openssl x509 -in /tmp/alice.pem -noout -startdate -enddate").splitlines()
        )
        start, end = (datetime.strptime(dates[name], "%b %d %H:%M:%S %Y %Z") for name in ("notBefore", "notAfter"))
        assert end - start == timedelta(minutes=6), dates
        # the serial number in the log is the session name: all 20 octets, in hex
        serial = machine.succeed("openssl x509 -in /tmp/alice.pem -noout -serial").strip().removeprefix("serial=").lower()
        assert len(serial) == 40, serial
        machine.succeed(f"journalctl -u 'rolesanywhere@*' | grep -q 'issued {serial} subject=machine:alice until=[0-9]* to alice (pid [0-9]*'")

    with subtest("anyone not in clients is refused"):
        assert "no access to /run/rolesanywhere/certificate.sock" in refusal_as("bob")
        # root reaches the socket, and the issuer itself refuses
        assert "root is not in services.rolesanywhere.clients" in refusal_as("root")

    with subtest("aws_signing_helper trades the certificate for credentials"):
        machine.succeed("systemd-run --unit endpoint ${pkgs.python3.interpreter} ${endpoint} /tmp/request.json")
        machine.wait_for_open_port(8099)
        output = machine.succeed(
            f"su - alice -c 'rolesanywhere-credentials {arns} --endpoint http://127.0.0.1:8099'"
        )
        credentials = json.loads(output)
        assert credentials["Version"] == 1 and credentials["AccessKeyId"] == "ASIATEST", credentials
        request = json.loads(machine.succeed("cat /tmp/request.json"))
        headers = {name.lower(): value for name, value in request["headers"].items()}
        assert headers["authorization"].startswith("AWS4-X509-ECDSA-SHA256 Credential="), headers
        assert "roleArn=arn%3Aaws%3Aiam%3A%3A${account}%3Arole%2Ftest" in request["path"], request
        # the certificate the request carries is alice's, from the CA
        sent = base64.b64decode(headers["x-amz-x509"])
        machine.succeed(f"echo {base64.b64encode(sent).decode()} | base64 -d | openssl x509 -inform DER -out /tmp/sent.pem")
        machine.succeed(f"openssl verify -x509_strict -CAfile {registered} /tmp/sent.pem")
        assert "subject=CN=machine:alice" in machine.succeed("openssl x509 -in /tmp/sent.pem -noout -subject")

    with subtest("the throwaway key only ever exists in memory"):
        machine.fail("grep -rlI --devices=skip 'PRIVATE KEY' /tmp /home /root /run /var /etc")

    with subtest("the CA key survives a reboot"):
        # the emulated TPM2 keeps its state in the machine's state directory
        machine.shutdown()
        machine.start()
        machine.wait_for_unit("rolesanywhere.socket")
        check_alice()

    with subtest("after a PCR 7 change the TPM2 derives another CA key"):
        machine.succeed("tpm2_pcrextend 7:sha256=" + "ab" * 32)
        assert "this TPM2's CA key is not the registered CA certificate's" in refusal_as("alice")
        assert register() != first
        check_alice()
  '';
}
