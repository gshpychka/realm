{ config, lib, ... }:
# Global configuration options and values.
# Identity values shared with non-module Nix live in values.nix.
let
  values = import ./values.nix;
in
{
  options.my = {
    domain = lib.mkOption {
      type = lib.types.str;
      default = values.domain;
      description = "Public domain name";
    };
    user = lib.mkOption {
      type = lib.types.str;
      default = values.user;
      description = "Main username";
    };
    sshKeys = lib.mkOption {
      type = lib.types.submodule {
        options = {
          main = lib.mkOption {
            type = lib.types.str;
            description = "Main SSH public key";
          };
          homeassistant = lib.mkOption {
            type = lib.types.str;
            description = "SSH public key for home assistant";
          };
          gitlab = lib.mkOption {
            type = lib.types.str;
            description = "SSH public key for GitLab";
          };
          hoardTpm = lib.mkOption {
            type = lib.types.str;
            description = "SSH public key derived from hoard's TPM";
          };
        };
      };
      description = "SSH public keys";
    };
    nixbuildKeys = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "SSH public keys for distributed builds";
    };
    buildServers = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            hostName = lib.mkOption {
              type = lib.types.str;
              description = "Hostname to connect to";
            };
            systems = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "Supported systems";
            };
            maxJobs = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Maximum concurrent jobs";
            };
            speedFactor = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Relative speed factor";
            };
            supportedFeatures = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "Supported features";
            };
            mandatoryFeatures = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "Mandatory features";
            };
            sshUser = lib.mkOption {
              type = lib.types.str;
              description = "Username for builds";
            };
          };
        }
      );
      default = { };
      description = "Build server configurations";
    };
    ollama = {
      host = lib.mkOption {
        type = lib.types.str;
        description = "Fleet host serving the ollama API";
      };
      proxyPath = lib.mkOption {
        type = lib.types.str;
        description = "nginx location proxying the ollama API root; the trailing slash drives proxy_pass path rewriting";
      };
      baseUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://${config.my.ollama.host}.${config.my.domain}${config.my.ollama.proxyPath}v1";
        description = "OpenAI-compatible API root, reachable from the LAN and the tunnels routed into it";
      };
    };
    netconsole = {
      host = lib.mkOption {
        type = lib.types.str;
        description = "Fleet host receiving kernel netconsole output";
      };
      port = lib.mkOption {
        type = lib.types.port;
        description = "UDP port the netconsole receiver listens on";
      };
    };
  };
  config = {
    my.sshKeys = {
      main = values.sshKeys.main;
      homeassistant = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAC9nquQBUuHWrWJvuUJLuR2zfupJp+QtQlpck0n5J0J";
      gitlab = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH1ykR9CzbUNoPsyPqgs9OYIgUCRNOHj8KefPhYJv+qr";
      hoardTpm = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBJOrPEgiVddcT1t+mm+xsbDnfj+nl1PBQyxzk5rQjeqPG3nkgWp/l8pIYrZojckIIOHLNERy1zYLigKGYp5crcA= openclaw@hoard";
    };
    my.nixbuildKeys = {
      eve = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP7jjV4iQfoCWZYWw2Q1bdsNg6PBc4U2SclLE2Wil0b9 nixbuild-eve@eve";
      hoard = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFy/oQXrAZW1aGN6w9RpXBREZ7jvZid2hO508mw8x0yT nixbuild-hoard@hoard";
      harbor = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABSB7E2A8KEVWo5u+fDHa74I16/1UcukAZps6902H3r nixbuild-harbor@harbor";
    };
    my.ollama = {
      host = "reaper";
      proxyPath = "/ollama/";
    };
    my.buildServers = {
      reaper = {
        hostName = "reaper";
        systems = [
          "x86_64-linux"
          "aarch64-linux"
        ];
        maxJobs = 16;
        speedFactor = 4;
        supportedFeatures = [
          "nixos-test"
          "benchmark"
          "big-parallel"
          "kvm"
        ];
        mandatoryFeatures = [ ];
        sshUser = "nixbuild";
      };
    };
    my.netconsole = {
      host = "harbor";
      port = 6666;
    };
    time.timeZone = "Europe/Kyiv";
  };
}
