{
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
      # Leap-second contract: https://developers.google.com/time/faq
      server time.google.com iburst
      server time.windows.com iburst

      # Authenticated sources can report incorrect time.
      minsources 2
      # Selection permits an unauthenticated quorum.
      authselectmode ignore
    '';
  };
}
