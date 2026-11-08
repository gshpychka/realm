{
  # Compare independent operators instead of accepting a single NTP-pool peer.
  # NTS authenticates Cloudflare, not the correctness of its clock: selection
  # still needs agreement from at least two sources.
  services.chrony = {
    enable = true;
    enableNTS = true;
    servers = [ ];
    enableRTCTrimming = false;
    makestep = {
      threshold = 1;
      limit = 3;
    };
    extraConfig = ''
      server time.cloudflare.com iburst nts
      server time.google.com iburst
      server time.windows.com iburst

      minsources 2
      # Permit the two public NTP sources to provide fallback without Cloudflare.
      # Authentication remains checked on Cloudflare packets, but is not a
      # prerequisite for clock selection. This is not an authenticated quorum.
      authselectmode ignore

      # Google leap-smears while Cloudflare uses standard leap seconds. These
      # sources are not interchangeable during a leap-smear window; retain
      # source agreement rather than forcing a preferred provider's clock.
    '';
  };
}
