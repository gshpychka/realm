# VM test of services.rolesanywhere on an emulated TPM2: the CA's lifecycle
# (generated, registered, kept across a reboot, replaced after a PCR 7 change
# or on request), who gets a certificate, and aws_signing_helper trading one
# for credentials at a stand-in for the Roles Anywhere endpoint.
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
        # The CA is generated in the VM's TPM2, after the build, so the test
        # registers it by writing this file.
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

    current = "/var/lib/rolesanywhere/current"
    registered = "/etc/rolesanywhere-test/registered.pem"
    arns = (
        "--trust-anchor-arn arn:aws:rolesanywhere:us-east-1:${account}:trust-anchor/11111111-1111-1111-1111-111111111111 "
        "--profile-arn arn:aws:rolesanywhere:us-east-1:${account}:profile/22222222-2222-2222-2222-222222222222 "
        "--role-arn arn:aws:iam::${account}:role/test"
    )


    def ca() -> str:
        return machine.succeed(f"readlink {current}").strip()


    def certificate_as(user: str) -> str:
        return machine.succeed(f"su - {user} -c 'rolesanywhere-credentials --certificate'")


    def refusal_as(user: str) -> str:
        return machine.fail(f"su - {user} -c 'rolesanywhere-credentials --certificate' 2>&1")


    def register() -> None:
        machine.succeed(f"install -D -m 0644 {current}/ca.pem {registered}")


    def ca_log() -> str:
        return machine.succeed("journalctl -u rolesanywhere-ca")


    machine.wait_for_unit("rolesanywhere-ca.service")
    machine.wait_for_unit("rolesanywhere.socket")

    with subtest("the CA's key is in the TPM2, usable only through PCR 7"):
        first = ca()
        public = machine.succeed(f"tpm2_print -t TPM2B_PUBLIC {current}/key.pub")
        attributes = public.split("attributes:")[1].split("\n")[1]
        for attribute in ("fixedtpm", "fixedparent", "sensitivedataorigin", "adminwithpolicy", "sign"):
            assert attribute in attributes, attributes
        assert "userwithauth" not in attributes, attributes
        machine.succeed(f"test $(stat -c %a {current}/key.priv) = 600")
        text = machine.succeed(f"openssl x509 -in {current}/ca.pem -noout -text")
        assert "CA:TRUE, pathlen:0" in text, text
        assert "Certificate Sign" in text, text

    with subtest("nothing is issued before the CA is registered"):
        assert f"CA {first} is not registered with AWS ({registered} is unreadable)" in ca_log()
        assert f"this machine's CA {first} is not registered with AWS" in refusal_as("alice")

    with subtest("once registered, alice gets a 5-minute certificate for machine:alice"):
        register()
        machine.succeed("systemctl restart rolesanywhere-ca")
        assert f"CA {first} is the one registered with AWS" in ca_log()
        machine.succeed(f"cat > /tmp/alice.pem <<'EOF'\n{certificate_as('alice')}EOF")
        machine.succeed(f"openssl verify -x509_strict -CAfile {registered} /tmp/alice.pem")
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

    with subtest("the throwaway key is written to no file"):
        machine.fail("grep -rlI --devices=skip 'PRIVATE KEY' /tmp /home /root /run /var /etc")

    with subtest("the CA survives a reboot"):
        # the emulated TPM2 keeps its state in the machine's state directory
        machine.shutdown()
        machine.start()
        machine.wait_for_unit("rolesanywhere-ca.service")
        assert ca() == first
        certificate_as("alice")

    with subtest("after a PCR 7 change the TPM2 refuses, and the CA is replaced"):
        machine.succeed("tpm2_pcrextend 7:sha256=" + "ab" * 32)
        assert "the TPM2 did not sign" in refusal_as("alice")
        machine.succeed("systemctl restart rolesanywhere-ca")
        second = ca()
        assert second != first
        assert f"replacing CA {first}: the TPM2 refuses to sign with its key: PCR 7 changed" in ca_log()
        machine.fail(f"test -e /var/lib/rolesanywhere/{first}")
        assert f"this machine's CA {second} is not registered with AWS" in refusal_as("alice")
        register()
        machine.succeed(f"cat > /tmp/alice.pem <<'EOF'\n{certificate_as('alice')}EOF")
        machine.succeed(f"openssl verify -x509_strict -CAfile {registered} /tmp/alice.pem")

    with subtest("rolesanywhere-replace-ca replaces the CA on request"):
        machine.succeed("rolesanywhere-replace-ca")
        assert ca() != second
        assert f"replacing CA {second}: a replacement was requested" in ca_log()
  '';
}
