# VM test of services.rolesanywhere on an emulated TPM2: the CA key the TPM2
# derives, who gets a certificate, and aws_signing_helper trading one for
# credentials at a stand-in for the Roles Anywhere endpoint.
#   nix build .#checks.x86_64-linux.rolesanywhere-vm
{ pkgs }:
let
  # answers CreateSession with dummy credentials, shaped like the real response
  # (https://docs.aws.amazon.com/rolesanywhere/latest/APIReference/API_CreateSession.html)
  endpoint = pkgs.writeText "endpoint.py" ''
    import json
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
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
      users.users.alice.isNormalUser = true;
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
    import json

    registered = "/etc/rolesanywhere-test/registered.pem"
    arns = (
        "--trust-anchor-arn arn:aws:rolesanywhere:us-east-1:${account}:trust-anchor/11111111-1111-1111-1111-111111111111 "
        "--profile-arn arn:aws:rolesanywhere:us-east-1:${account}:profile/22222222-2222-2222-2222-222222222222 "
        "--role-arn arn:aws:iam::${account}:role/test"
    )


    def refusal_as(user: str) -> str:
        return machine.fail(f"su - {user} -c 'rolesanywhere-credentials --certificate' 2>&1")


    machine.wait_for_unit("rolesanywhere.socket")
    # registers a CA certificate for the TPM2's CA key
    machine.succeed("${rolesanywhere} ca-certificate > /tmp/ca.pem")
    machine.succeed(f"install -D -m 0644 /tmp/ca.pem {registered}")

    with subtest("alice gets a certificate for machine:alice, and it is logged"):
        machine.succeed("su - alice -c 'rolesanywhere-credentials --certificate' > /tmp/alice.pem")
        machine.succeed(f"openssl verify -x509_strict -CAfile {registered} /tmp/alice.pem")
        assert "subject=CN=machine:alice" in machine.succeed("openssl x509 -in /tmp/alice.pem -noout -subject")
        serial = machine.succeed("openssl x509 -in /tmp/alice.pem -noout -serial").strip().removeprefix("serial=").lower()
        machine.succeed(f"journalctl -u 'rolesanywhere@*' | grep -q 'issued {serial} subject=machine:alice until=[0-9]* to alice (pid [0-9]*'")

    with subtest("the issuer refuses a user not in clients"):
        # root reaches the socket despite its mode and group
        assert "root is not in services.rolesanywhere.clients" in refusal_as("root")

    with subtest("aws_signing_helper trades the certificate for credentials"):
        machine.succeed("systemd-run --unit endpoint ${pkgs.python3.interpreter} ${endpoint}")
        machine.wait_for_open_port(8099)
        output = machine.succeed(
            f"su - alice -c 'rolesanywhere-credentials {arns} --endpoint http://127.0.0.1:8099'"
        )
        assert json.loads(output)["AccessKeyId"] == "ASIATEST", output

    with subtest("after a PCR 7 change the TPM2 derives another CA key, which the issuer refuses"):
        machine.succeed("tpm2_pcrextend 7:sha256=" + "ab" * 32)
        assert "this TPM2's CA key is not the registered CA certificate's" in refusal_as("alice")
  '';
}
